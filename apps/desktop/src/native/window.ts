// The app window, behind a small adapter so the browser build (dev server, Playwright) works the same way.
// - Title: Tauri `getCurrentWindow().setTitle()` (needs `core:window:allow-set-title`); in a browser, document.title.
// - Focus: the window's own focus and blur events; `focusWindow()` brings it forward (notification clicks).
// Dev builds expose `window.__tesseraWindowFocus(false | true | null)` so tests can pretend the window lost the focus
// (null hands control back to the real events).
import { isTauri } from "@tauri-apps/api/core";
import { commands, unwrap } from "@tessera/ipc";
import { isNativeRuntime } from "./runtime";

declare global {
  interface Window {
    __tesseraWindowFocus?: (focused: boolean | null) => void;
  }
}

let lastTitle: string | null = null;
type FocusCommands = { focusMain(): Promise<void> };

const nativeFocus: FocusCommands = {
  async focusMain() {
    await unwrap(commands.windowFocusMain());
  },
};

export function focusMainWindow(isNative: boolean = isNativeRuntime(), client: FocusCommands = nativeFocus) {
  return isNative ? client.focusMain() : Promise.resolve();
}

export async function setWindowTitle(title: string): Promise<void> {
  if (title === lastTitle) return;
  lastTitle = title;
  if (!isTauri()) {
    document.title = title;
    return;
  }
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    await getCurrentWindow().setTitle(title);
  } catch {
    // Missing permission or a closing window: the title is cosmetic.
  }
}

export async function focusWindow(): Promise<void> {
  if (!isTauri()) {
    window.focus();
    return;
  }
  await focusMainWindow();
}

/** Calls `onChange` with the window's focus now and on every change. Returns the unsubscribe. */
export function watchWindowFocus(onChange: (focused: boolean) => void): () => void {
  let forced: boolean | null = null;
  const report = () => onChange(forced ?? document.hasFocus());
  const onFocus = () => {
    if (forced === null) onChange(true);
  };
  const onBlur = () => {
    if (forced === null) onChange(false);
  };
  window.addEventListener("focus", onFocus);
  window.addEventListener("blur", onBlur);
  if (import.meta.env.DEV) {
    window.__tesseraWindowFocus = (focused) => {
      forced = focused;
      report();
    };
  }
  report();
  return () => {
    window.removeEventListener("focus", onFocus);
    window.removeEventListener("blur", onBlur);
  };
}
