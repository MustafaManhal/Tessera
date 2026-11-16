// Session restore, front end (M3.4, FR-23): `startAutosave` saves the layout JSON 500 ms after the last change and when
// the page goes away; `restoreLayout` loads it at start, parses it (repairs small damage, refuses garbage and layouts
// from a newer version) and replaces the layout state. Neither ever blocks startup or throws: a layout that cannot be
// used gives one fresh tab and one notice.
import { LAYOUT_VERSION, type LayoutState, parseLayout, serializeLayout } from "../layout";
import type { AppStore } from "../store";
import { layout } from "../store/layoutSlice";
import type { LayoutStore, WindowBounds } from "./store";
import { markRestored } from "./restored";

export const AUTOSAVE_DELAY_MS = 500;
export const LOAD_TIMEOUT_MS = 2000;
export const MAIN_WINDOW = "main";

export interface AutosaveOptions {
  store: AppStore;
  layoutStore: LayoutStore;
  windowId?: string;
  delayMs?: number;
  bounds?: () => WindowBounds | null;
  saveInitial?: boolean;
  setTimer?: (run: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export interface Autosave {
  /** Saves now if the layout changed since the last save. */
  flush(): void;
  stop(): void;
}

/** The window's bounds in CSS pixels, when the browser says (a best effort; Rust reports the real monitor). */
export function windowBounds(): WindowBounds | null {
  if (typeof window === "undefined" || !Number.isFinite(window.outerWidth) || window.outerWidth === 0) return null;
  return { x: window.screenX, y: window.screenY, w: window.outerWidth, h: window.outerHeight, monitor: null };
}

export function startAutosave(options: AutosaveOptions): Autosave {
  const { store, layoutStore, windowId = MAIN_WINDOW, delayMs = AUTOSAVE_DELAY_MS } = options;
  const setTimer = options.setTimer ?? ((run, ms) => setTimeout(run, ms));
  const clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  let last = options.saveInitial ? "" : JSON.stringify(serializeLayout(store.getState().layout));
  let seen: LayoutState = store.getState().layout;
  let timer: unknown = null;

  const flush = () => {
    if (timer !== null) {
      clearTimer(timer);
      timer = null;
    }
    const json = serializeLayout(store.getState().layout);
    const text = JSON.stringify(json);
    if (text === last) return;
    last = text;
    void layoutStore.save(windowId, json, options.bounds?.() ?? null).catch(() => {
      // Saving is best effort: the next change tries again.
      last = "";
    });
  };

  const unsubscribe = store.subscribe(() => {
    const current = store.getState().layout;
    if (current === seen) return;
    seen = current;
    if (timer !== null) clearTimer(timer);
    timer = setTimer(flush, delayMs);
  });
  const onHide = () => flush();
  if (typeof window !== "undefined") {
    window.addEventListener("pagehide", onHide);
    window.addEventListener("beforeunload", onHide);
  }
  return {
    flush,
    stop() {
      unsubscribe();
      if (timer !== null) clearTimer(timer);
      timer = null;
      if (typeof window !== "undefined") {
        window.removeEventListener("pagehide", onHide);
        window.removeEventListener("beforeunload", onHide);
      }
    },
  };
}

export type RestoreOutcome =
  | { kind: "off" }
  | { kind: "none" }
  | { kind: "restored"; tabs: number; repairs: string[] }
  | { kind: "failed"; reason: string };

export interface RestoreOptions {
  store: AppStore;
  layoutStore: LayoutStore;
  /** `window.restore`: off means start fresh (the autosave still keeps the layout current). */
  enabled: boolean;
  windowId?: string;
  timeoutMs?: number;
}

/** Loads the saved layout and puts it into the store. Never throws and never waits longer than `timeoutMs`. */
export async function restoreLayout(options: RestoreOptions): Promise<RestoreOutcome> {
  const { store, layoutStore, windowId = MAIN_WINDOW, timeoutMs = LOAD_TIMEOUT_MS } = options;
  if (!options.enabled) return { kind: "off" };
  let saved: Awaited<ReturnType<LayoutStore["load"]>>;
  try {
    saved = await Promise.race([
      layoutStore.load(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timed out")), timeoutMs)),
    ]);
  } catch (cause) {
    return { kind: "failed", reason: cause instanceof Error ? cause.message : String(cause) };
  }
  const entry = saved.find((candidate) => candidate.window_id === windowId);
  if (!entry) return { kind: "none" };
  if (
    (typeof entry.state === "string" && entry.state.trim() === "{}") ||
    (typeof entry.state === "object" &&
      entry.state !== null &&
      !Array.isArray(entry.state) &&
      Object.keys(entry.state).length === 0)
  ) {
    return { kind: "none" };
  }
  const parsed = parseLayout(entry.state, { cwd: "~" });
  if (!parsed.ok) return { kind: "failed", reason: parsed.error };
  if (parsed.value.tabs.length === 0) return { kind: "none" };
  const ids = Object.keys(parsed.value.panes);
  markRestored(ids);
  store.dispatch(layout({ type: "layout/replace", state: parsed.value }, "none"));
  return { kind: "restored", tabs: parsed.value.tabs.length, repairs: parsed.repairs };
}

export { LAYOUT_VERSION };
