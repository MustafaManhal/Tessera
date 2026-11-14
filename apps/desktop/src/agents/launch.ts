// Starting an agent: the front end owns the PTY (Rust only builds the plan). This module turns a plan into a pane,
// delivers the prompt the way the plan says (stdin, or typed once the agent prints its ready line), and reports the
// lifecycle back. The pane's terminal spawns with `PaneInfo.launch`; `agentPaneSpawned` binds the session and starts
// the delivery, `agentPaneOutput` feeds it the decoded output, `agentPaneExited` reports the exit.
import { t } from "@tessera/ui";
import { activeTabOf, type LayoutState } from "../layout";
import { notifications } from "../notify";
import type { AppThunk } from "../store";
import { layout } from "../store/layoutSlice";
import { announce } from "../store/uiSlice";
import { agentsErrorMessage } from "./errors";
import { agentsClient } from "./service";
import { resumeErrorSet, launchReplaced, launchSet, paneCleared, sessionUpserted } from "./sessionsSlice";
import type { AgentLaunch, AgentSession, AgentStartInput } from "./types";

const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";
/** How long a "type" mode agent gets to print its ready line before the prompt is sent anyway. */
export const READY_TIMEOUT_MS = 15_000;

export type DeliveryResult = "stdin" | "typed" | "timeout" | "none";

export interface PromptDelivery {
  /** Called with the pane's output; only "type" mode listens. */
  feed(bytes: Uint8Array): void;
  cancel(): void;
  done: Promise<DeliveryResult>;
}

export interface DeliveryOptions {
  /** Overrides the 15 s ready wait (tests). */
  timeoutMs?: number;
  /** The agent did not print its ready line; the prompt was sent anyway. */
  onTimeout?: () => void;
}

/** A compiled ready pattern, or null when there is none or it is not a valid RegExp (then delivery does not wait). */
function compileReady(pattern: string | null): RegExp | null {
  if (!pattern) return null;
  try {
    return new RegExp(pattern);
  } catch {
    return null;
  }
}

/**
 * Delivers a plan's prompt: `stdin` writes it after spawn; `type_after_ready` waits for the ready pattern (at most 15 s,
 * then sends it anyway and calls `onTimeout`). No prompt (or "arg"/"flag" modes, whose prompt is already in `args`)
 * delivers nothing.
 */
export function deliverPrompt(
  plan: Pick<AgentLaunch, "stdin" | "type_after_ready" | "ready_pattern" | "agent_name">,
  write: (text: string) => void | Promise<void>,
  options: DeliveryOptions = {},
): PromptDelivery {
  let settled = false;
  let cancelled = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const decoder = new TextDecoder();
  let seen = "";
  let resolve: (result: DeliveryResult) => void = () => {};
  const done = new Promise<DeliveryResult>((done) => {
    resolve = done;
  });

  const finish = (result: DeliveryResult) => {
    if (settled) return;
    settled = true;
    if (timer !== null) clearTimeout(timer);
    timer = null;
    resolve(result);
  };
  const send = (result: DeliveryResult) => {
    if (cancelled || settled) return;
    if (plan.type_after_ready === null) return finish("none");
    // Bracketed paste keeps the agent's TUI from interpreting the text as keystrokes; then Enter runs it.
    void write(`${PASTE_START}${plan.type_after_ready}${PASTE_END}`);
    void write("\r");
    finish(result);
  };

  if (plan.stdin !== null) {
    if (plan.stdin !== "") void write(plan.stdin);
    finish("stdin");
    return {
      feed: () => {},
      cancel: () => {
        cancelled = true;
      },
      done,
    };
  }

  if (plan.type_after_ready === null) {
    finish("none");
    return {
      feed: () => {},
      cancel: () => {
        cancelled = true;
      },
      done,
    };
  }

  const pattern = compileReady(plan.ready_pattern);
  if (!pattern) {
    // No usable pattern: send now rather than wait for something that never matches.
    send("typed");
  } else {
    timer = setTimeout(() => {
      if (cancelled || settled) return;
      options.onTimeout?.();
      send("timeout");
    }, options.timeoutMs ?? READY_TIMEOUT_MS);
  }

  return {
    feed: (bytes) => {
      if (settled || cancelled || !pattern) return;
      // Match the visible text: ConPTY (Windows) wraps output in cursor and mode escapes.
      seen += stripEscapes(decoder.decode(bytes, { stream: true }));
      if (pattern.test(seen)) {
        if (seen.length > 64 * 1024) seen = seen.slice(-128);
        send("typed");
      } else if (seen.length > 64 * 1024) {
        seen = seen.slice(-4096);
      }
    },
    cancel: () => {
      cancelled = true;
      if (!settled) finish("none");
    },
    done,
  };
}

/** CSI (`ESC [ … final`), OSC (`ESC ] … BEL` or `ESC \\`) and two-byte escapes removed. */
export function stripEscapes(text: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: matching terminal escape sequences is the point.
  return text.replace(/\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-_]/g, "");
}

// Deliveries in flight, by pane. Output from the terminal is fed here; a pane without one is a plain shell.
const deliveries = new Map<string, PromptDelivery>();

export function agentPaneOutput(paneId: string, bytes: Uint8Array): void {
  deliveries.get(paneId)?.feed(bytes);
}

function beginDelivery(paneId: string, plan: AgentLaunch, write: (text: string) => void | Promise<void>): void {
  deliveries.get(paneId)?.cancel();
  const delivery = deliverPrompt(plan, write, {
    onTimeout: () => {
      notifications().toastNow({ title: t("agents.launch.notReady", { name: plan.agent_name }) });
    },
  });
  deliveries.set(paneId, delivery);
  void delivery.done.then(() => {
    if (deliveries.get(paneId) === delivery) deliveries.delete(paneId);
  });
}

export interface StartAgentInput {
  profileId: string;
  prompt: string | null;
  taskId: string | null;
  cwd: string | null;
}

/**
 * Starts an agent: `agentStart` builds the plan, then the front end opens an agent pane (in the task's tab, or a new
 * tab) whose terminal spawns the plan's program. The prompt is delivered once the pane reports its PTY.
 */
export const startAgent =
  (input: StartAgentInput): AppThunk<Promise<AgentLaunch>> =>
  async (dispatch, getState) => {
    const plan = await agentsClient().agentStart({
      task_id: input.taskId,
      profile_id: input.profileId,
      prompt: input.prompt,
      cwd: input.cwd,
    } satisfies AgentStartInput);
    const state = getState();
    // An agent gets its own tab, in the task's folder, instead of splitting the task's terminal.
    const cwd = plan.cwd ?? (state.layout.tabs.length > 0 ? undefined : "~");
    dispatch(
      layout({
        type: "tab/new",
        kind: "agent",
        ...(cwd ? { cwd } : {}),
        ...(input.taskId ? { taskId: input.taskId } : {}),
        title: plan.agent_name,
      }),
    );
    const active = activeTabOf(getState().layout);
    if (!active) throw new Error("The agent tab could not be created.");
    bindPlan(dispatch, active.focusedPane, plan);
    return plan;
  };

/**
 * Gives a new pane its plan before it renders: the terminal spawns the plan's program (`PaneInfo.launch`) in the plan's
 * folder, and the header reads the plan from the sessions slice. Both dispatches land before React renders the pane.
 */
function bindPlan(dispatch: (action: unknown) => unknown, paneId: string, plan: AgentLaunch): void {
  dispatch(launchSet({ paneId, launch: plan }));
  if (plan.cwd) dispatch(layout({ type: "pane/setCwd", paneId, cwd: plan.cwd }));
  dispatch(
    layout({ type: "pane/setLaunch", paneId, launch: { program: plan.program, args: plan.args, env: plan.env } }),
  );
}

// How to stop each agent pane: registered by the pane's header (it holds the PTY client), used by the header's Stop
// button and by the "Stop agent" action.
const stoppers = new Map<string, () => void>();

export function registerAgentStopper(paneId: string, stop: () => void): () => void {
  stoppers.set(paneId, stop);
  return () => {
    if (stoppers.get(paneId) === stop) stoppers.delete(paneId);
  };
}

export function stopAgentInPane(paneId: string): boolean {
  const stop = stoppers.get(paneId);
  stop?.();
  return !!stop;
}

/** The focused pane of the active tab when it runs an agent. */
export function focusedAgentPane(state: {
  layout: LayoutState;
  agentSessions: { launches: Record<string, AgentLaunch> };
}): string | null {
  const tab = activeTabOf(state.layout);
  const paneId = tab?.focusedPane;
  return paneId && state.agentSessions.launches[paneId] ? paneId : null;
}

/** Binds the agent session to the pane's PTY and starts the prompt delivery (called when the terminal spawns). */
export const agentPaneSpawned =
  (input: {
    paneId: string;
    /** The PTY session; null right after a launch (the terminal reports it). */
    paneSessionId: string | null;
    write: ((text: string) => void | Promise<void>) | null;
  }): AppThunk<Promise<AgentSession | null>> =>
  async (dispatch, getState) => {
    const launch = getState().agentSessions.launches[input.paneId];
    if (!launch || input.paneSessionId === null) return null;
    if (input.write) beginDelivery(input.paneId, launch, input.write);
    try {
      const session = await agentsClient().agentSessionAttach(
        launch.agent_session_id,
        input.paneSessionId,
        input.paneId,
      );
      dispatch(sessionUpserted(session));
      return session;
    } catch {
      // The pane still works; the header shows no status rather than an error the user cannot act on.
      return null;
    }
  };

/** The pane's PTY exited: report it, which ends the agent session. */
export const agentPaneExited =
  (paneId: string, exitCode: number | null): AppThunk<Promise<AgentSession | null>> =>
  async (dispatch, getState) => {
    deliveries.get(paneId)?.cancel();
    deliveries.delete(paneId);
    const launch = getState().agentSessions.launches[paneId];
    if (!launch) return null;
    // Idempotent: the pane-close path can report the same exit the PTY event already did.
    const known = getState().agentSessions.sessions[launch.agent_session_id];
    if (known?.status === "exited") return known;
    try {
      const session = await agentsClient().agentSessionExited(launch.agent_session_id, exitCode);
      dispatch(sessionUpserted(session));
      return session;
    } catch {
      return null;
    }
  };

/** Restarts the pane's agent: a new plan, then the terminal spawns again in the same slot. */
export const restartAgentPane =
  (paneId: string): AppThunk<Promise<AgentLaunch | null>> =>
  async (dispatch, getState) => {
    const launch = getState().agentSessions.launches[paneId];
    if (!launch) return null;
    const plan = await agentsClient().agentRestart(launch.agent_session_id);
    deliveries.get(paneId)?.cancel();
    deliveries.delete(paneId);
    dispatch(launchReplaced({ paneId, launch: plan }));
    dispatch(
      layout({
        type: "pane/relaunch",
        paneId,
        launch: { program: plan.program, args: plan.args, env: plan.env },
      }),
    );
    return plan;
  };

export const resumeAgentPane =
  (paneId: string): AppThunk<Promise<AgentLaunch | null>> =>
  async (dispatch, getState) => {
    const launch = getState().agentSessions.launches[paneId];
    if (!launch) return null;
    dispatch(resumeErrorSet({ paneId, message: "" }));
    let plan: AgentLaunch;
    try {
      plan = await agentsClient().agentResume(launch.agent_session_id);
    } catch (cause) {
      dispatch(resumeErrorSet({ paneId, message: agentsErrorMessage(cause) }));
      throw cause;
    }
    deliveries.get(paneId)?.cancel();
    deliveries.delete(paneId);
    dispatch(launchReplaced({ paneId, launch: plan }));
    dispatch(
      layout({
        type: "pane/relaunch",
        paneId,
        launch: { program: plan.program, args: plan.args, env: plan.env },
      }),
    );
    return plan;
  };

/**
 * A restored pane whose shell is gone (the app was closed for a while, the daemon ended, the computer restarted):
 * if an agent ran in it, continue that conversation with the agent's own resume command, in the same folder.
 * Resolves "resumed" (the pane relaunches by itself), "failed" (an agent ran here but cannot resume: the pane starts a
 * plain shell, never the original launch that would send the first prompt again) or "none" (no agent ran here).
 */
export const resumeRestoredAgentPane =
  (paneId: string): AppThunk<Promise<"resumed" | "failed" | "none">> =>
  async (dispatch) => {
    let rows: AgentSession[];
    try {
      rows = await agentsClient().agentSessionsList(null);
    } catch {
      return "none";
    }
    const here = rows.filter((row) => row.pane_id === paneId).sort((a, b) => b.started_at - a.started_at);
    if (here.length === 0) return "none";
    // The newest session of this pane. Its conversation id may never have been captured (that needs the agent's status
    // hooks); the backend then asks the agent to continue its latest conversation in the folder.
    const last = here[0];
    if (!last) return "failed";
    let plan: AgentLaunch;
    try {
      plan = await agentsClient().agentResume(last.id);
    } catch {
      return "failed";
    }
    dispatch(launchReplaced({ paneId, launch: plan }));
    dispatch(
      layout({
        type: "pane/relaunch",
        paneId,
        launch: { program: plan.program, args: plan.args, env: plan.env },
      }),
    );
    return "resumed";
  };

/** Stops the pane's agent by killing its PTY session; the exit is reported back through `agentPaneExited`. */
export const stopAgentPane =
  (paneId: string, kill: (paneSessionId: string) => Promise<void>): AppThunk<Promise<void>> =>
  async (_dispatch, getState) => {
    const launch = getState().agentSessions.launches[paneId];
    if (!launch) return;
    const session = getState().agentSessions.sessions[launch.agent_session_id];
    if (session?.pane_session_id) await kill(session.pane_session_id);
  };

/**
 * A pane left the layout (closed, its tab closed, a layout restore): end its prompt delivery, report the exit the
 * dead PTY can no longer send (the terminal's own exit event does not survive the unmount), and forget the launch.
 * The listener middleware calls this for every launch whose pane disappeared.
 */
export const paneRemoved =
  (paneId: string): AppThunk =>
  async (dispatch, getState) => {
    deliveries.get(paneId)?.cancel();
    deliveries.delete(paneId);
    stoppers.delete(paneId);
    const launch = getState().agentSessions.launches[paneId];
    if (launch) {
      const session = getState().agentSessions.sessions[launch.agent_session_id];
      if (session && session.status !== "exited") {
        try {
          const ended = await agentsClient().agentSessionExited(launch.agent_session_id, session.exit_code);
          dispatch(sessionUpserted(ended));
        } catch {
          // The pane is gone; there is nowhere to show the failure.
        }
      }
    }
    dispatch(paneCleared(paneId));
  };

/** Announces a launched agent the way other long actions do (the toast names it). */
export const announceAgentStarted =
  (plan: AgentLaunch): AppThunk =>
  (dispatch) => {
    dispatch(announce(t("agents.launch.started", { name: plan.agent_name })));
  };

/** Kept out of the slice on purpose: the toast is only needed by the profile picker's own flow. */
export function agentLaunchToast(plan: AgentLaunch): void {
  notifications().toastNow({ title: t("agents.launch.started", { name: plan.agent_name }) });
}
