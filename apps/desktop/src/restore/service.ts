// The app's LayoutStore and the one-time outcome of the start-up restore (shown as a toast by RestoreHost).
import type { PaneId } from "../layout";
import { type RestoreOutcome, restoreLayout, startAutosave, windowBounds } from "./persist";
import { FakeLayoutStore, TauriLayoutStore, type LayoutBindings, type LayoutStore } from "./store";
import type { AppStore } from "../store";
import { setRestoreSession } from "../store/settingsSlice";

export const RESTORE_KEY = "tessera.restoreSession";
export const SCROLLBACK_LOAD_TIMEOUT_MS = 500;

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

/** Returns saved bytes for a restored pane, bounded so a slow backend cannot block terminal startup. */
export async function restoreScrollback(paneId: PaneId): Promise<Uint8Array | null> {
  if (!activeLayoutStore) return null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      activeLayoutStore.loadScrollback(paneId),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("scrollback load timed out")), SCROLLBACK_LOAD_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

/** Restores the saved layout, then starts autosaving. Resolves when panes may mount; never rejects. */
export async function startSessionRestore(store: AppStore, layoutStore: LayoutStore, windowId = "main"): Promise<void> {
  activeLayoutStore = layoutStore;
  const enabled = readRestoreSetting();
  store.dispatch(setRestoreSession(enabled));
  const outcome = await restoreLayout({ store, layoutStore, enabled, windowId });
  notice = outcome.kind === "restored" || outcome.kind === "failed" ? outcome : null;
  autosave?.stop();
  autosave = startAutosave({
    store,
    layoutStore,
    windowId,
    bounds: windowBounds,
    saveInitial: outcome.kind !== "restored",
  });
  // Save the fresh start too, so a layout that failed to load is replaced by a good one.
  if (outcome.kind !== "restored") autosave.flush();
}

export type { PaneId };
