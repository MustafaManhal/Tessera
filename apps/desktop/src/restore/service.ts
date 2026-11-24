// The app's LayoutStore and the one-time outcome of the start-up restore (shown as a toast by RestoreHost).
import type { PaneId } from "../layout";
import { MAIN_WINDOW, type RestoreOutcome, restoreLayout, startAutosave, windowBounds } from "./persist";
import { isNativeRuntime } from "../native/runtime";
import { INITIAL_CWD, layout } from "../store/layoutSlice";
import { FakeLayoutStore, TauriLayoutStore, type LayoutBindings, type LayoutStore } from "./store";
import type { AppStore } from "../store";
import { setRestoreSession } from "../store/settingsSlice";

export const RESTORE_KEY = "tessera.restoreSession";
/** Start-up loads every restored pane at once; past this the pane starts without its old history. */
export const SCROLLBACK_LOAD_TIMEOUT_MS = 5000;

declare global {
  interface Window {
    __tesseraLayoutStore?: LayoutStore;
  }
}

/** `window.restore` is not in the config schema yet, so it is kept on this computer (default on). */
export function readRestoreSetting(): boolean {
  try {
    return localStorage.getItem(RESTORE_KEY) !== "false";
  } catch {
    return true;
  }
}

export function saveRestoreSetting(enabled: boolean): void {
  try {
    localStorage.setItem(RESTORE_KEY, String(enabled));
  } catch {
    // Blocked storage: the choice lasts for this session.
  }
}

/** The native app passes bindings here once available; browser mode and tests keep the persistent fake by default. */
export function createLayoutStore(bindings: LayoutBindings | null = null): LayoutStore {
  const store = bindings ? new TauriLayoutStore(bindings) : new FakeLayoutStore(true);
  activeLayoutStore = store;
  if (import.meta.env.DEV && typeof window !== "undefined") window.__tesseraLayoutStore = store;
  return store;
}

let notice: RestoreOutcome | null = null;
let autosave: ReturnType<typeof startAutosave> | null = null;
let activeLayoutStore: LayoutStore | null = null;

/** The outcome of the start-up restore, once (RestoreHost shows it). */
export function takeRestoreNotice(): RestoreOutcome | null {
  const taken = notice;
  notice = null;
  return taken;
}

export function flushLayout(): void {
  autosave?.flush();
}

/**
 * Returns saved bytes for a restored pane, bounded so a slow backend cannot block terminal startup. A load that takes
 * too long gives null (the pane starts without the old history) rather than an error: the user cannot act on it.
 */
export async function restoreScrollback(paneId: PaneId): Promise<Uint8Array | null> {
  if (!activeLayoutStore) return null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      activeLayoutStore.loadScrollback(paneId),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => {
          console.warn(
            `Scrollback for pane ${paneId} took over ${SCROLLBACK_LOAD_TIMEOUT_MS} ms; starting without it.`,
          );
          resolve(null);
        }, SCROLLBACK_LOAD_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

/**
 * Whether a window with nothing to restore opens one home terminal. The main window does not: Tessera never opens a
 * terminal the user did not ask for. A new window the user opened does (that is what they asked for). The browser
 * preview and the UI tests run on a fake shell and keep a starter terminal unless the address says `start=empty`.
 */
function wantsStarterTab(windowId: string): boolean {
  if (windowId !== MAIN_WINDOW) return true;
  if (isNativeRuntime()) return false;
  return new URLSearchParams(window.location.search).get("start") !== "empty";
}

/** Restores the saved layout, then starts autosaving. Resolves when panes may mount; never rejects. */
export async function startSessionRestore(store: AppStore, layoutStore: LayoutStore, windowId = "main"): Promise<void> {
  activeLayoutStore = layoutStore;
  const enabled = readRestoreSetting();
  store.dispatch(setRestoreSession(enabled));
  const outcome = await restoreLayout({ store, layoutStore, enabled, windowId });
  notice = outcome.kind === "restored" || outcome.kind === "failed" ? outcome : null;
  autosave?.stop();
  if (outcome.kind !== "restored" && store.getState().layout.tabs.length === 0 && wantsStarterTab(windowId)) {
    store.dispatch(layout({ type: "tab/new", cwd: INITIAL_CWD }, "pane"));
  }
  // A load that failed (slow disk, damaged row) keeps the saved session on disk: saving the empty start now would
  // replace the user's tabs for good. The first real change saves as usual.
  const fresh = outcome.kind === "none" || outcome.kind === "off";
  autosave = startAutosave({
    store,
    layoutStore,
    windowId,
    bounds: windowBounds,
    saveInitial: fresh,
  });
  if (fresh) autosave.flush();
}

export type { PaneId };
