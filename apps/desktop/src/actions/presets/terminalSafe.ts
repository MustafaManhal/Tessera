// "Terminal-safe" Windows preset: the Windows defaults, minus the chords that steal readline keys from the shell.
// Ctrl+F (forward-char) and Ctrl+K (kill-line) move to Ctrl+Shift chords; everything else is unchanged.
import type { ShortcutSpec } from "../keymap";
import { WINDOWS_PRESET } from "./windows";

export const TERMINAL_SAFE_OVERRIDES: Record<string, ShortcutSpec[]> = {
  "terminal.find": ["Ctrl+Shift+F"],
  "sidebar.focusSearch": ["Ctrl+Alt+Shift+F"],
  "view.palette": ["Ctrl+Shift+P"],
};

export const TERMINAL_SAFE_PRESET: Record<string, ShortcutSpec[]> = { ...WINDOWS_PRESET, ...TERMINAL_SAFE_OVERRIDES };
