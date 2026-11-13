// TerminalPane: the real terminal behind the PaneContent contract (shell/pane/PaneContent.ts).
//
// Contract with the PtyClient (packages/term/src/pty/client.ts):
// 1. Mount the engine once fonts are ready, then `spawn({kind, cwd, cols, rows}, onEvent)` with the measured grid.
// 2. Keystrokes: engine.onData gives UTF-8 bytes → `client.write(session, bytes)`. Never strings or JSON.
// 3. Output: each `data` event → `engine.write(bytes, done)`; `done` runs after xterm processed the bytes and only then
//    do we `ack` them (batched by createAckAccounting), so a slow renderer slows the host, not the UI.
// 4. Grid changes (fit after element resize, font changes) → `client.resize(session, cols, rows, px_w, px_h)`.
// 5. `title` and `cwd` events and the OSC 0/2, OSC 7 and OSC 133/633 sequences the shell prints → onTitleChange,
//    onCwdChange, onRunningProcessChange.
// 6. `exit` → overlay "Process exited with code N"; Enter or Restart spawns again in the last cwd, same engine
//    (scrollback kept).
// 7. Unmount (the pane closed) → `client.kill(session)`. Switching tabs or zooming never unmounts a pane.
import { benchMark } from "../native/benchmark";
import { getAccessibilityPrefs, useAccessibilityPrefs } from "../accessibility/prefs";
import { Button, getPlatform, Icons, Kbd, t, useToast } from "@tessera/ui";
import {
  createAckAccounting,
  createCwdFilter,
  createEngine,
  type EngineOptions,
  type PtyClient,
  PtyError,
  type PtyEvent,
  type TerminalEngine,
} from "@tessera/term";
import {
  type DragEvent,
  type Ref,
  useCallback,
  useEffect,
  useImperativeHandle,
  useReducer,
  useRef,
  useState,
} from "react";
import { takeNativeShortcut } from "../actions/shortcuts";
import type { PaneContentHandle, PaneContentProps } from "../shell/pane/PaneContent";
import { useAppDispatch, useAppSelector } from "../store/hooks";
import { setTerminal, type TerminalSettings } from "../store/settingsSlice";
import { findPathLinks, parsePathLink, resolvePath, safeUrl, wantsOpen } from "./links";
import { openExternal, openInEditor } from "./open";
import { BlockControls } from "./blocks/BlockControls";
import { useBlocks } from "./blocks/useBlocks";
import { Osc52Confirm } from "./Osc52Confirm";
import { registerPaneTerminal } from "./panes";
import { consumeTransferDetach, trackTransferAttach, transferReadiness } from "./transferState";
import { asOneLine, pasteNeedsConfirm, quotePaths, stripControlCharacters, trimTrailingWhitespace } from "./paste";
import { type PasteChoice, PasteConfirm } from "./PasteConfirm";
import { usePtyClient } from "./ptyClient";
import { consumeRestored, MODE_RESET, REPORTING_RESET } from "../restore/restored";
import { restoreScrollback } from "../restore/service";
import { initialSession, liveSession, sessionReducer } from "./session";
import { SearchBar, type SearchBarHandle } from "./SearchBar";
import { readTerminalTheme, useTerminalTheme } from "./theme";
import { useAgentObserver } from "../agents/observe";
import { selectSession } from "../agents/sessionsSlice";
import { useOscFeatures } from "./useOscFeatures";
import { summarizeLatency } from "./latency";
import { reportNativeCommandError } from "../native/errors";
import { broadcastInput, setBroadcastPasteConfirmation } from "./broadcast";
import {
  ptyDiagnosticsEnabled,
  readPtyDiagnostics,
  subscribePtyDiagnostics,
  updatePtyDiagnostics,
  type PtyPaneDiagnostics,
} from "./ptyDiagnostics";

const encoder = new TextEncoder();

interface HoverLink {
  label: string;
  x: number;
  y: number;
}

interface LatencyMark {
  key: string;
  startedAt: number;
  line: number;
  column: number;
  renderVersion: number;
  writeProcessed: boolean;
  frameReady: boolean;
  paintedAt: number | null;
}

const FALLBACK_FONTS = '"Symbols Nerd Font Mono", ui-monospace, "SF Mono", Menlo, Consolas, monospace';

/** Whether a paste event carries an image (a copied screenshot or image file). */
function clipboardHasImage(data: DataTransfer | null): boolean {
  if (!data) return false;
  return Array.from(data.items ?? []).some((item) => item.kind === "file" && item.type.startsWith("image/"));
}

/** Whether the clipboard holds an image, asked through the clipboard API (the paste action has no event). */
async function clipboardApiHasImage(): Promise<boolean> {
  try {
    const items = await navigator.clipboard.read();
    return items.some((item) => item.types.some((type) => type.startsWith("image/")));
  } catch {
    return false;
  }
}

export function engineOptions(settings: TerminalSettings, screenReader = false): Omit<EngineOptions, "theme"> {
  return {
    fontFamily: `"${settings.fontFamily}", ${FALLBACK_FONTS}`,
    fontSize: settings.fontSize,
    lineHeight: settings.lineHeight,
    fontWeight: settings.fontWeight,
    fontWeightBold: 700,
    ligatures: settings.ligatures,
    cursorStyle: settings.cursorStyle,
    cursorBlink: settings.cursorBlink,
    scrollback: settings.scrollback,
    renderer: settings.renderer,
    macOptionIsMeta: false,
    screenReaderMode: screenReader,
    images: settings.images,
  };
}

/** `?renderer=dom` forces the DOM renderer (tests, or debugging a GPU problem). */
function rendererOverride(): "dom" | null {
  return new URLSearchParams(window.location.search).get("renderer") === "dom" ? "dom" : null;
}

export function TerminalPane(props: PaneContentProps & { ref?: Ref<PaneContentHandle> }) {
  const client = usePtyClient();
  if (!client) return null;
  return <TerminalPaneInner {...props} client={client} />;
}

function TerminalPaneInner({
  ref,
  tabId,
  client,
  paneId,
  kind,
  info,
  visible,
  onFocused,
  onCwdChange,
  onTitleChange,
  onRunningProcessChange,
  onSpawned,
  onOutput,
  onExit,
}: PaneContentProps & { ref?: Ref<PaneContentHandle>; client: PtyClient }) {
  const settings = useAppSelector((state) => state.settings.terminal);
  const theme = useTerminalTheme();
  const host = useRef<HTMLDivElement>(null);
  const [engine, setEngine] = useState<TerminalEngine | null>(null);
  const [session, dispatch] = useReducer(sessionReducer, initialSession);
  const sessionRef = useRef(session);
  sessionRef.current = session;
  const reclaim = useRef<((sessionId: string) => Promise<void>) | null>(null);
  const provisional = useRef(info.transfer?.pending === true);
  provisional.current = info.transfer?.pending === true;
  const waitingForCommit = provisional.current && !info.transfer?.sessionId && info.transfer?.exitCode === undefined;
  // Callbacks change identity on every render; the long-lived listeners read the latest ones through a ref.
  const callbacks = useRef({
    onCwdChange,
    onTitleChange,
    onRunningProcessChange,
    onFocused,
    onSpawned,
    onOutput,
    onExit,
    cwd: info.cwd,
  });
  callbacks.current = {
    onCwdChange,
    onTitleChange,
    onRunningProcessChange,
    onFocused,
    onSpawned,
    onOutput,
    onExit,
    cwd: info.cwd,
  };
  const appDispatch = useAppDispatch();
  const { toast } = useToast();
  const platform = getPlatform();
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const [searchOpen, setSearchOpen] = useState(false);
  const search = useRef<SearchBarHandle>(null);
  const [pendingPaste, setPendingPaste] = useState<string | null>(null);
  const [hover, setHover] = useState<HoverLink | null>(null);
  const debugEnabled = ptyDiagnosticsEnabled();
  const [ptyDiagnostics, setPtyDiagnostics] = useState<PtyPaneDiagnostics>(() => readPtyDiagnostics(paneId));
  const latencyMarks = useRef<LatencyMark[]>([]);
  const latencySamples = useRef<number[]>([]);
  // OSC 7 from this pane's own shell; a later one from another host (SSH) is ignored (packages/term/src/osc/cwd.ts).
  const [cwdFilter] = useState(() => createCwdFilter());
  // Agent panes feed the status engine: OSC via useOscFeatures, screen/silence via output ticks below.
  const agentSession = useAppSelector((state) => selectSession(state, paneId));
  const agentSessionId = useRef<string | null>(null);
  agentSessionId.current = agentSession && agentSession.ended_at === null ? agentSession.id : null;
  const agentObserver = useAgentObserver(engine, agentSessionId);
  const agentObserverRef = useRef(agentObserver);
  agentObserverRef.current = agentObserver;
  const onAgentObservation = useCallback((observation: Parameters<typeof agentObserver.observe>[0]) => {
    agentObserverRef.current.observe(observation);
  }, []);
  const osc = useOscFeatures(
    engine,
    paneId,
    settingsRef,
    {
      onChange: (path) => callbacks.current.onCwdChange(path),
    },
    onAgentObservation,
  );

  useEffect(() => {
    if (!debugEnabled) return;
    return subscribePtyDiagnostics((id, diagnostics) => {
      if (id === paneId) setPtyDiagnostics(diagnostics);
    });
  }, [debugEnabled, paneId]);

  // Off screen, the pane gives its WebGL context back (NFR-13).
  useEffect(() => {
    engine?.setVisible(visible);
  }, [engine, visible]);

  // A focus request can come before the engine is mounted (fonts still loading): keep it until then.
  const pendingFocus = useRef(false);
  useImperativeHandle(
    ref,
    () => ({
      focus: () => {
        if (engine) engine.focus();
        else pendingFocus.current = true;
      },
    }),
    [engine],
  );
  useEffect(() => {
    if (engine && pendingFocus.current) {
      pendingFocus.current = false;
      engine.focus();
    }
  }, [engine]);

  // 1. The engine: created once, mounted after the fonts are loaded so cells are measured with the real font.
  // biome-ignore lint/correctness/useExhaustiveDependencies: created once per pane; later changes go through setOptions.
  useEffect(() => {
    const element = host.current;
    if (!element) return;
    let cancelled = false;
    const created = createEngine({
      ...engineOptions(settings, getAccessibilityPrefs().screenReader),
      renderer: rendererOverride() ?? settings.renderer,
      theme: readTerminalTheme(),
    });
    benchMark("engine_created");
    void document.fonts.ready.then(() => {
      if (cancelled) return;
      benchMark("fonts_ready");
      created.mount(element);
      benchMark("engine_mounted");
      setEngine(created);
    });
    return () => {
      cancelled = true;
      created.dispose();
    };
  }, []);

  // Settings and theme apply live.
  const screenReader = useAccessibilityPrefs().screenReader;
  useEffect(() => {
    engine?.setOptions({ ...engineOptions(settings, screenReader), renderer: rendererOverride() ?? settings.renderer });
  }, [engine, settings, screenReader]);
  useEffect(() => {
    engine?.setOptions({ theme });
  }, [engine, theme]);

  // 2. What the shell prints about itself: title (OSC 0/2), cwd (OSC 7). The running command and the command blocks
  //    (OSC 133/633) are the BlockController's (useBlocks).
  useEffect(() => {
    if (!engine) return;
    const subscriptions = [
      engine.onTitle((title) => callbacks.current.onTitleChange(title || null)),
      engine.onOsc(7, (data) => {
        const path = cwdFilter.accept(data);
        if (path) callbacks.current.onCwdChange(path);
        return true;
      }),
      engine.onFocusChange((isFocused) => {
        if (isFocused) callbacks.current.onFocused();
      }),
    ];
    return () => {
      for (const subscription of subscriptions) subscription.dispose();
    };
  }, [engine, cwdFilter]);

  // 3. The session: spawned once the engine has a grid, again after Restart; killed when the pane goes away.
  // biome-ignore lint/correctness/useExhaustiveDependencies: one spawn per generation; status changes inside it do not respawn.
  useEffect(() => {
    if (!engine || session.status !== "starting" || waitingForCommit) return;
    if (info.transfer?.pending && !transferReadiness.has(info.transfer.id)) return;
    const generation = session.generation;
    let acks = createAckAccounting();
    let subscriber = 0;
    let sessionId: string | null = null;
    let unackedBeforeId = 0;
    let ended = false;
    let disposed = false;
    let renderVersion = 0;
    const recordPaintedMarks = () => {
      while (latencyMarks.current.length > 0) {
        const mark = latencyMarks.current[0];
        if (!mark?.writeProcessed || !mark.frameReady || mark.paintedAt === null) return;
        latencyMarks.current.shift();
        latencySamples.current.push(mark.paintedAt - mark.startedAt);
        if (latencySamples.current.length > 500) latencySamples.current.shift();
      }
      if (latencySamples.current.length > 0)
        window.__tessera_latency = summarizeLatency(latencySamples.current, engine.renderer);
    };
    const rendered = engine.onViewportChange(() => {
      renderVersion += 1;
      const paintedAt = performance.now();
      for (const mark of latencyMarks.current) {
        if (renderVersion <= mark.renderVersion) continue;
        const echoed = engine.line(mark.line)?.text.slice(mark.column, mark.column + mark.key.length);
        if (echoed === mark.key) mark.paintedAt = paintedAt;
      }
      recordPaintedMarks();
    });
    const ack = (bytes: number) => {
      if (bytes <= 0) return;
      if (sessionId) void client.ack(sessionId, bytes).catch(() => {});
      else unackedBeforeId += bytes;
    };
    const input = engine.onData((bytes) => {
      if (provisional.current || broadcastInput(tabId, bytes)) return;
      if (sessionId && !ended) void client.write(sessionId, bytes).catch(() => {});
    });
    const latencyKeydown = (event: KeyboardEvent) => {
      if (!import.meta.env.DEV || event.key.length !== 1 || event.ctrlKey || event.metaKey || event.altKey) return;
      let line = engine.cursor.line;
      let column = engine.cursor.x;
      for (const mark of latencyMarks.current) {
        if (mark.line === line) column = Math.max(column, mark.column + mark.key.length);
      }
      if (column >= engine.cols) {
        line += Math.floor(column / engine.cols);
        column %= engine.cols;
      }
      latencyMarks.current.push({
        key: event.key,
        startedAt: performance.now(),
        line,
        column,
        renderVersion,
        writeProcessed: false,
        frameReady: false,
        paintedAt: null,
      });
      if (latencyMarks.current.length > 64) latencyMarks.current.shift();
    };
    const terminalElement = host.current;
    terminalElement?.addEventListener("keydown", latencyKeydown, true);
    const resize = engine.onResize(({ cols, rows, pxWidth, pxHeight }) => {
      if (sessionId && !ended) void client.resize(sessionId, cols, rows, pxWidth, pxHeight).catch(() => {});
    });
    const onEvent = (event: PtyEvent) => {
      if (ended) return;
      if (event.type === "data") {
        const length = event.bytes.length;
        callbacks.current.onOutput?.(event.bytes);
        agentObserverRef.current.output();
        acks.received(length);
        const subscription = subscriber;
        engine.write(event.bytes, () => {
          if (subscription !== subscriber || ended) return;
          if (debugEnabled) {
            updatePtyDiagnostics(paneId, (current) => ({ writeCallbacks: current.writeCallbacks + 1 }));
          }
          ack(acks.processed(length));
          if (!import.meta.env.DEV) return;
          const mark = latencyMarks.current.find((candidate) => {
            if (candidate.writeProcessed) return false;
            const echoed = engine
              .line(candidate.line)
              ?.text.slice(candidate.column, candidate.column + candidate.key.length);
            return echoed === candidate.key;
          });
          if (!mark) return;
          mark.writeProcessed = true;
          requestAnimationFrame(() => {
            mark.frameReady = true;
            recordPaintedMarks();
          });
        });
      } else if (event.type === "exit") {
        ended = true;
        ack(acks.flush());
        callbacks.current.onRunningProcessChange(null);
        callbacks.current.onExit?.(event.code);
        dispatch({ type: "exited", generation, code: event.code });
      } else if (event.type === "title") {
        callbacks.current.onTitleChange(event.text || null);
      } else if (event.type === "cwd") {
        // The host reports the shell's real cwd (from the OS); trusted like a local OSC 7.
        callbacks.current.onCwdChange(event.path);
      }
    };
    const begin = (cwd: string): Promise<void> => {
      benchMark("spawn_requested");
      const subscription = subscriber;
      return client
        .spawn(
          {
            kind,
            cwd,
            cols: engine.cols,
            rows: engine.rows,
            paneId,
            ...(info.taskId ? { taskId: info.taskId } : {}),
            ...(info.launch ? { program: info.launch.program, args: info.launch.args, env: info.launch.env } : {}),
            diagnosticId: debugEnabled ? paneId : undefined,
          },
          (event) => {
            if (subscriber === subscription) onEvent(event);
          },
        )
        .then((id) => {
          if (ended) {
            void client.kill(id).catch(() => {});
            return;
          }
          sessionId = id;
          if (debugEnabled) updatePtyDiagnostics(paneId, { sessionId: id });
          if (unackedBeforeId > 0) {
            void client.ack(id, unackedBeforeId).catch(() => {});
            unackedBeforeId = 0;
          }
          dispatch({ type: "started", generation, sessionId: id });
          ready?.(paneId, true);
          callbacks.current.onSpawned?.(id);
        })
        .catch((cause: unknown) => {
          // The saved folder is gone (a restored pane, a deleted worktree): start in the home folder instead.
          if (cause instanceof PtyError && cause.kind === "CwdMissing" && cwd !== "~") {
            callbacks.current.onCwdChange("~");
            return begin("~");
          }
          ready?.(paneId, false);
          dispatch({
            type: "failed",
            generation,
            message: cause instanceof PtyError || cause instanceof Error ? cause.message : String(cause),
          });
        });
    };
    const attach = async (id: string, reset: boolean, staleReporting = false) => {
      const subscription = ++subscriber;
      if (reset) engine.write(encoder.encode("\x1bc\x1b[3J"));
      acks = createAckAccounting();
      sessionId = null;
      unackedBeforeId = 0;
      await client.attach(id, (event) => {
        if (subscriber === subscription) onEvent(event);
      });
      if (ended) return;
      sessionId = id;
      if (unackedBeforeId > 0) {
        void client.ack(id, unackedBeforeId).catch(() => {});
        unackedBeforeId = 0;
      }
      if (staleReporting) engine.write(encoder.encode(REPORTING_RESET));
      await client.resize(id, engine.cols, engine.rows, 0, 0);
      dispatch({ type: "started", generation, sessionId: id });
    };
    reclaim.current = async (id) => {
      if (liveSession(sessionRef.current) !== id) return;
      try {
        await attach(id, true);
      } catch (cause) {
        if (!(cause instanceof PtyError) || cause.kind !== "UnknownSession") throw cause;
        ended = true;
        dispatch({ type: "exited", generation, code: -1 });
      }
    };
    const transfer = generation === 1 ? info.transfer : undefined;
    const ready = transfer ? transferReadiness.get(transfer.id) : undefined;
    if (transfer?.exitCode !== undefined) {
      dispatch({ type: "exited", generation, code: transfer.exitCode });
      ready?.(paneId, true);
    } else if (transfer?.sessionId) {
      void trackTransferAttach(transfer.id, attach(transfer.sessionId, false)).then(
        () => ready?.(paneId, !disposed),
        (cause: unknown) => {
          ready?.(paneId, false);
          dispatch({ type: "failed", generation, message: String(cause) });
        },
      );
    } else if (consumeRestored(paneId)) {
      // The session daemon may still run this pane's shell from the last run: re-attach it (its scrollback replays).
      // Otherwise show the saved history above a divider and start a new shell.
      const live = client.liveSession ? client.liveSession(paneId).catch(() => null) : Promise.resolve(null);
      void live.then(async (id) => {
        if (id && !ended) {
          try {
            await attach(id, false, true);
            return;
          } catch {
            // It ended between the lookup and the attach: restore as usual.
          }
        }
        const scrollback = await restoreScrollback(paneId).catch((cause: unknown) => {
          reportNativeCommandError("native.scrollbackLoadFailed", cause);
          return null;
        });
        if (ended) return;
        if (scrollback) {
          engine.write(scrollback);
          engine.write(encoder.encode(MODE_RESET));
        }
        engine.write(encoder.encode(`\x1b[2m── ${t("restore.divider")} ──\x1b[0m\r\n`));
        return begin(callbacks.current.cwd || "~");
      });
    } else {
      void begin(callbacks.current.cwd || "~");
    }
    return () => {
      disposed = true;
      input.dispose();
      resize.dispose();
      rendered.dispose();
      terminalElement?.removeEventListener("keydown", latencyKeydown, true);
      latencyMarks.current = [];
      // The pane closed (or restarted after an exit): end this session.
      const detaching = consumeTransferDetach(paneId);
      if (sessionId && !ended && !detaching && !provisional.current) void client.kill(sessionId).catch(() => {});
      reclaim.current = null;
      ended = true;
    };
  }, [engine, session.generation, client, tabId, waitingForCommit, info.restartKey]);

  useEffect(() => () => setBroadcastPasteConfirmation(paneId, false), [paneId]);

  // Enter restarts an exited session.
  useEffect(() => {
    if (!engine || session.status === "running" || session.status === "starting") return;
    const keys = engine.onData((bytes) => {
      if (bytes.length === 1 && bytes[0] === 13) dispatch({ type: "restart" });
    });
    return () => keys.dispose();
  }, [engine, session.status]);

  // An agent relaunch (`pane/relaunch`) bumps restartKey: reset the session so the spawn effect runs again with the
  // new launch. Without it the pane would keep showing the old session's exited (or running) state.
  const restartKeySeen = useRef(info.restartKey);
  useEffect(() => {
    if (info.restartKey === restartKeySeen.current) return;
    restartKeySeen.current = info.restartKey;
    dispatch({ type: "relaunch" });
  }, [info.restartKey]);

  const ended = session.status === "exited" || session.status === "failed";

  /** Text typed into the session (dropped paths). */
  const insert = useCallback(
    (text: string) => {
      const id = liveSession(sessionRef.current);
      if (id && text) void client.write(id, encoder.encode(text)).catch(() => {});
    },
    [client],
  );

  /** Ctrl+V: agents such as Claude Code read a copied image from the system clipboard when they get this key. */
  const sendImagePasteKey = useCallback(() => {
    const id = liveSession(sessionRef.current);
    if (id) void client.write(id, new Uint8Array([0x16])).catch(() => {});
  }, [client]);

  const blocks = useBlocks({
    engine,
    host,
    paneId,
    settings: settingsRef,
    cwd: () => callbacks.current.cwd || null,
    write: insert,
    onRunningProcessChange: (process) => callbacks.current.onRunningProcessChange(process),
  });

  /** Pastes through the confirmation rules: several lines or control characters ask first (FR-07). */
  const paste = useCallback(
    (raw: string, plain = false) => {
      if (!engine || raw === "") return;
      const text = plain ? stripControlCharacters(raw) : raw;
      const mode = settingsRef.current.pasteConfirm;
      if (mode === "always" || (mode === "multiline" && pasteNeedsConfirm(text))) {
        setBroadcastPasteConfirmation(paneId, true);
        setPendingPaste(text);
      } else engine.paste(text);
    },
    [engine, paneId],
  );

  const choosePaste = (choice: PasteChoice, dontAskAgain: boolean) => {
    const text = pendingPaste;
    setPendingPaste(null);
    setBroadcastPasteConfirmation(paneId, false);
    if (dontAskAgain) appDispatch(setTerminal({ pasteConfirm: "never" }));
    if (text !== null && engine) {
      if (choice === "paste") engine.paste(text);
      else if (choice === "oneLine") engine.paste(asOneLine(text));
    }
    engine?.focus();
  };

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    if (!event.dataTransfer.types.includes("Files")) return;
    event.preventDefault();
    // A browser gives names, not paths; the app gets full paths from the native drop event (drop.ts).
    const names = Array.from(event.dataTransfer.files, (file) => file.name);
    insert(quotePaths(names, platform));
    engine?.focus();
  };

  const copySelection = useCallback(async () => {
    if (!engine?.hasSelection()) return false;
    const selection = engine.getSelection();
    await navigator.clipboard.writeText(
      settingsRef.current.trimTrailingWhitespace ? trimTrailingWhitespace(selection) : selection,
    );
    return true;
  }, [engine]);

  const blockApi = blocks.api;
  useEffect(() => {
    if (!engine || !blockApi) return;
    const openSearch = () => {
      setSearchOpen(true);
      requestAnimationFrame(() => search.current?.focus());
    };
    return registerPaneTerminal(paneId, {
      engine,
      transferSession: () => {
        const current = sessionRef.current;
        if (current.status === "running") return { sessionId: current.sessionId };
        if (current.status === "exited") return { exitCode: current.code };
        return {};
      },
      reclaimSession: (id) => reclaim.current?.(id) ?? Promise.resolve(),
      openSearch,
      find: (direction) => {
        if (search.current) search.current.find(direction);
        else openSearch();
      },
      paste,
      pasteFromClipboard: async (plain) => {
        const text = await navigator.clipboard.readText().catch(() => "");
        if (text === "" && (await clipboardApiHasImage())) {
          sendImagePasteKey();
          return;
        }
        paste(text, plain);
      },
      insert,
      writeInput: (bytes) => {
        const id = liveSession(sessionRef.current);
        if (!id) return false;
        void client.write(id, bytes).catch(() => {});
        return true;
      },
      copySelection,
      blocks: blockApi,
    });
  }, [engine, paneId, paste, insert, copySelection, blockApi, client, sendImagePasteKey]);

  // Clipboard events on the terminal: copy trims trailing whitespace (per setting); paste goes through the rules.
  useEffect(() => {
    const element = host.current;
    if (!engine || !element) return;
    const onPaste = (event: ClipboardEvent) => {
      event.preventDefault();
      event.stopPropagation();
      const text = event.clipboardData?.getData("text/plain") ?? "";
      // A copied image has no text: send Ctrl+V, the key agents such as Claude Code answer by reading the image from
      // the system clipboard themselves (a terminal cannot carry image bytes).
      if (text === "" && clipboardHasImage(event.clipboardData)) {
        sendImagePasteKey();
        return;
      }
      paste(text, takeNativeShortcut("terminal.pastePlain"));
    };
    const onCopy = (event: ClipboardEvent) => {
      if (!engine.hasSelection()) return;
      event.preventDefault();
      event.stopPropagation();
      const selection = engine.getSelection();
      event.clipboardData?.setData(
        "text/plain",
        settingsRef.current.trimTrailingWhitespace ? trimTrailingWhitespace(selection) : selection,
      );
    };
    // Middle click pastes (off by default on macOS).
    const onAuxClick = (event: MouseEvent) => {
      if (event.button !== 1 || !settingsRef.current.middleClickPaste) return;
      event.preventDefault();
      void navigator.clipboard
        .readText()
        .then((text) => paste(text))
        .catch(() => {});
    };
    element.addEventListener("paste", onPaste, { capture: true });
    element.addEventListener("copy", onCopy, { capture: true });
    element.addEventListener("auxclick", onAuxClick);
    const selection = engine.onSelectionChange(() => {
      if (settingsRef.current.copyOnSelect && engine.hasSelection()) void copySelection().catch(() => {});
    });
    return () => {
      element.removeEventListener("paste", onPaste, { capture: true });
      element.removeEventListener("copy", onCopy, { capture: true });
      element.removeEventListener("auxclick", onAuxClick);
      selection.dispose();
    };
  }, [engine, paste, copySelection, sendImagePasteKey]);

  // Links: URLs, OSC 8 and path:line. Cmd/Ctrl+click opens; hovering shows where it goes.
  useEffect(() => {
    if (!engine) return;
    const element = host.current;
    const describe = (kind: "url" | "osc8" | "path", text: string) => {
      if (kind === "path") {
        const link = parsePathLink(text);
        return link ? `${resolvePath(link.path, callbacks.current.cwd)}:${link.line}` : null;
      }
      return safeUrl(text);
    };
    engine.setLinkHandlers({
      findPaths: findPathLinks,
      activate: (link, event) => {
        if (!wantsOpen(event, platform)) return;
        if (link.kind === "path") {
          const parsed = parsePathLink(link.text);
          if (!parsed) return;
          const opened = openInEditor(resolvePath(parsed.path, callbacks.current.cwd), parsed.line, parsed.column);
          if (!opened) toast({ title: t("link.editorLater"), description: describe("path", link.text) ?? undefined });
          return;
        }
        void openExternal(link.text).then((opened) => {
          if (!opened) toast({ kind: "error", title: t("link.blocked"), description: link.text });
        });
      },
      hover: (link, event) => {
        const box = element?.getBoundingClientRect();
        setHover({
          label: describe(link.kind, link.text) ?? t("link.blocked"),
          x: event.clientX - (box?.left ?? 0),
          y: event.clientY - (box?.top ?? 0),
        });
      },
      leave: () => setHover(null),
    });
    return () => engine.setLinkHandlers(null);
  }, [engine, platform, toast]);

  return (
    <div
      className="relative h-full min-h-0 bg-term-bg"
      data-terminal-pane={paneId}
      data-session={liveSession(session) ?? ""}
    >
      {debugEnabled && (
        <pre
          data-pty-debug={paneId}
          aria-hidden="true"
          className="pointer-events-none absolute right-3 top-3 z-30 max-w-[min(28rem,90%)] overflow-hidden rounded-md border border-border bg-surface/95 p-2 text-xs text-fg shadow-popover"
        >
          {JSON.stringify({ paneId, ...ptyDiagnostics }, null, 2)}
        </pre>
      )}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: a drop target for files; the terminal inside has the keyboard. */}
      <div
        ref={host}
        data-terminal
        className="absolute inset-0 overflow-hidden p-1.5"
        onDragOver={(event) => {
          if (event.dataTransfer.types.includes("Files")) event.preventDefault();
        }}
        onDrop={onDrop}
      />
      {searchOpen && engine && (
        <SearchBar
          ref={search}
          engine={engine}
          onClose={() => {
            setSearchOpen(false);
            engine.focus();
          }}
        />
      )}
      {hover && (
        <div
          role="tooltip"
          className="pointer-events-none absolute z-20 flex max-w-[min(32rem,80%)] items-center gap-2 rounded-md border border-border bg-surface-3 px-2 py-1 text-sm text-fg shadow-popover"
          style={{ left: Math.max(8, hover.x + 12), top: hover.y + 16 }}
        >
          <span className="min-w-0 truncate">{hover.label}</span>
          <Kbd shortcut={platform === "mac" ? "Cmd+Click" : "Ctrl+Click"} />
        </div>
      )}
      <BlockControls
        controller={blocks.controller}
        api={blocks.api}
        container={host}
        rerunAsk={blocks.rerunAsk}
        onRerunAnswer={blocks.answerRerun}
      />
      <PasteConfirm text={pendingPaste} onChoose={choosePaste} />
      {osc.pendingCopy !== null && <Osc52Confirm count={osc.pendingCopy} onChoose={osc.answerCopy} />}
      {ended && (
        <div
          role="status"
          className="absolute inset-x-3 bottom-3 z-10 flex flex-wrap items-center gap-3 rounded-lg border border-border bg-surface px-3 py-2 text-base text-fg shadow-popover"
        >
          <Icons.CircleStop size={16} className="shrink-0 text-muted" aria-hidden />
          <span className="min-w-0 flex-1">
            {session.status === "exited"
              ? t("terminal.exited", { code: session.code })
              : t("terminal.failed", { message: session.message })}
            <span className="ms-2 text-sm text-muted">{t("terminal.restartHint")}</span>
          </span>
          <Button size="sm" variant="primary" icon={Icons.RotateCcw} onClick={() => dispatch({ type: "restart" })}>
            {t("terminal.restart")}
          </Button>
        </div>
      )}
    </div>
  );
}
