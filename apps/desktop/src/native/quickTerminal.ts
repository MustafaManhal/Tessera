// Quick terminal (FR-21, S-15): the window with label "quick" is the drop-down terminal the global hotkey shows. Rust
// owns the window, the hotkey and the slide (quick_terminal.rs); this module tells the window apart from the others and
// wraps the commands.
import { commands, unwrap } from "@tessera/ipc";
import { isNativeRuntime } from "./runtime";

export const QUICK_WINDOW = "quick";

let currentLabel = "main";

/** Set once at startup from the native window label (main.tsx), before the first render. */
export function setWindowLabel(label: string): void {
  currentLabel = label;
}

/** True in the quick terminal window: compact chrome, no sidebar or status bar, own tabs. */
export function isQuickWindow(): boolean {
  return currentLabel === QUICK_WINDOW;
}

/** Shows the quick terminal, or hides it when shown. Fails when it is off in settings. */
export async function toggleQuickTerminal(): Promise<void> {
  if (!isNativeRuntime()) return;
  unwrap(await commands.quickTerminalToggle());
}

export async function hideQuickTerminal(): Promise<void> {
  if (!isNativeRuntime()) return;
  unwrap(await commands.quickTerminalHide());
}

/** Rust slides the window unless the user asked for reduced motion; then the content fades in instead. */
export async function reportReducedMotion(reduced: boolean): Promise<void> {
  if (!isNativeRuntime()) return;
  await commands.quickTerminalSetReducedMotion(reduced);
}
