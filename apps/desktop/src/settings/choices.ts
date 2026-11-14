// Settings that used to be typed are picked from a list instead, so nobody can enter a value the app cannot use. Each
// entry lists the allowed values for one config key. A value already in the config file that is not in the list stays
// selectable as "Custom: …", so an older or hand-edited config is never rewritten behind the user's back.
import { loadBundledThemes } from "../themes/catalog";

export interface Choice {
  value: string;
  label: string;
}

export type ChoiceKind = "string" | "number";

export interface ChoiceSet {
  kind: ChoiceKind;
  choices: Choice[];
}

const num = (values: number[], label: (n: number) => string): Choice[] =>
  values.map((n) => ({ value: String(n), label: label(n) }));
const pct = (n: number) => `${Math.round(n * 100)}%`;

export const MONO_FONTS = [
  "JetBrains Mono",
  "Fira Code",
  "Cascadia Code",
  "Cascadia Mono",
  "SF Mono",
  "Menlo",
  "Monaco",
  "Consolas",
  "Source Code Pro",
  "IBM Plex Mono",
  "Hack",
  "Inconsolata",
  "Roboto Mono",
  "Ubuntu Mono",
  "Courier New",
  "monospace",
];

export const EDITORS: Choice[] = [
  { value: "code", label: "Visual Studio Code" },
  { value: "cursor", label: "Cursor" },
  { value: "windsurf", label: "Windsurf" },
  { value: "zed", label: "Zed" },
  { value: "subl", label: "Sublime Text" },
  { value: "idea", label: "IntelliJ IDEA" },
  { value: "webstorm", label: "WebStorm" },
  { value: "pycharm", label: "PyCharm" },
  { value: "goland", label: "GoLand" },
  { value: "rustrover", label: "RustRover" },
  { value: "studio", label: "Android Studio" },
  { value: "nvim", label: "Neovim" },
  { value: "vim", label: "Vim" },
  { value: "emacs", label: "Emacs" },
  { value: "nano", label: "nano" },
  { value: "hx", label: "Helix" },
];

export const SHELLS: Choice[] = [
  { value: "auto", label: "Automatic (your login shell)" },
  { value: "zsh", label: "zsh" },
  { value: "bash", label: "bash" },
  { value: "fish", label: "fish" },
  { value: "sh", label: "sh" },
  { value: "nu", label: "Nushell" },
  { value: "pwsh", label: "PowerShell 7" },
  { value: "powershell", label: "Windows PowerShell" },
  { value: "cmd", label: "Command Prompt" },
];

const HOTKEYS = [
  "Ctrl+`",
  "Ctrl+Space",
  "Ctrl+Alt+Space",
  "Ctrl+Alt+T",
  "Ctrl+Shift+`",
  "Alt+Space",
  "F12",
  "Cmd+Shift+Space",
  "Cmd+Alt+T",
];

const SETS: Record<string, ChoiceSet> = {
  "editor.command": { kind: "string", choices: EDITORS },
  "shell.default": { kind: "string", choices: SHELLS },
  "font.family": { kind: "string", choices: MONO_FONTS.map((value) => ({ value, label: value })) },
  "font.size": {
    kind: "number",
    choices: num([9, 10, 11, 12, 13, 14, 15, 16, 18, 20, 22, 24, 28, 32], (n) => `${n} pt`),
  },
  "font.line-height": {
    kind: "number",
    choices: num([1, 1.1, 1.2, 1.3, 1.4, 1.5, 1.7, 2], (n) =>
      n === 1.2 ? "1.2 (default)" : n === 1 ? "1 (tight)" : n === 2 ? "2 (airy)" : String(n),
    ),
  },
  "appearance.ui-zoom": { kind: "number", choices: num([0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2], pct) },
  "appearance.window-opacity": { kind: "number", choices: num([1, 0.95, 0.9, 0.85, 0.8, 0.7, 0.6], pct) },
  "appearance.dim-unfocused": {
    kind: "number",
    choices: num([0, 0.1, 0.2, 0.3, 0.4, 0.5], (n) => (n === 0 ? "Off" : pct(n))),
  },
  "appearance.padding": { kind: "number", choices: num([0, 2, 4, 6, 8, 12, 16, 24], (n) => `${n} px`) },
  "quick-terminal.hotkey": { kind: "string", choices: HOTKEYS.map((value) => ({ value, label: value })) },
  "quick-terminal.height": {
    kind: "number",
    choices: num([0.25, 0.3, 0.4, 0.5, 0.6, 0.75, 1], (n) => `${pct(n)} of the screen`),
  },
  "worktrees.branch-prefix": {
    kind: "string",
    choices: [
      { value: "tessera/", label: "tessera/ (default)" },
      { value: "agent/", label: "agent/" },
      { value: "task/", label: "task/" },
      { value: "feature/", label: "feature/" },
      { value: "wip/", label: "wip/" },
      { value: "", label: "No prefix" },
    ],
  },
  "worktrees.dir": {
    kind: "string",
    choices: [
      { value: "auto", label: "Automatic (next to the project)" },
      { value: ".tessera/worktrees", label: "Inside the project (.tessera/worktrees)" },
    ],
  },
  "terminal.scrollback": {
    kind: "number",
    choices: num([1000, 5000, 10000, 25000, 50000, 100000, 500000], (n) => `${n.toLocaleString("en-US")} lines`),
  },
  "terminal.long-command-notify-seconds": {
    kind: "number",
    choices: [
      { value: "0", label: "Never" },
      ...num([10, 20, 30, 60, 120, 300, 600], (n) => (n < 60 ? `${n} seconds` : `${n / 60} minutes`)),
    ],
  },
};

/** The fixed choices for a config key, or null when the key is not a pick-from-a-list setting. */
/** Terminal editors, always offered: they run in a terminal, so the app list cannot tell if they are installed. */
const TERMINAL_EDITORS: Choice[] = [
  { value: "nvim", label: "Neovim" },
  { value: "vim", label: "Vim" },
  { value: "emacs", label: "Emacs" },
  { value: "nano", label: "nano" },
  { value: "hx", label: "Helix" },
];

/** Offers the editors found on this computer for `editor.command` (called when Settings opens). */
export function setInstalledEditors(found: { id: string; name: string; installed: boolean }[]): void {
  const installed = found
    .filter((editor) => editor.installed)
    .map((editor) => ({ value: editor.id, label: editor.name }));
  if (installed.length === 0) return;
  SETS["editor.command"] = { kind: "string", choices: [...installed, ...TERMINAL_EDITORS] };
}

export function choiceSetFor(key: string): ChoiceSet | null {
  return SETS[key] ?? null;
}

/** The set with the current value added as "Custom: …" when the list does not contain it. */
export function withCurrent(set: ChoiceSet, current: unknown): Choice[] {
  if (current === undefined || current === null) return set.choices;
  const text = String(current);
  if (set.choices.some((choice) => choice.value === text)) return set.choices;
  return [{ value: text, label: `Custom: ${text === "" ? "(empty)" : text}` }, ...set.choices];
}

export function parseChoice(set: ChoiceSet, value: string): string | number {
  return set.kind === "number" ? Number(value) : value;
}

/** Font features the terminal font can switch on. */
export const FONT_FEATURES: Choice[] = [
  { value: "calt", label: "Ligatures (calt)" },
  { value: "liga", label: "Standard ligatures (liga)" },
  { value: "ss01", label: "Style set 1" },
  { value: "ss02", label: "Style set 2" },
  { value: "ss03", label: "Style set 3" },
  { value: "ss04", label: "Style set 4" },
  { value: "ss05", label: "Style set 5" },
  { value: "zero", label: "Slashed zero" },
  { value: "cv01", label: "Variant 1" },
  { value: "cv02", label: "Variant 2" },
];

/** "Do not disturb until" as a few durations; the value is saved as a Unix timestamp in seconds (0 = off). */
export const DND_OPTIONS: Choice[] = [
  { value: "off", label: "Off" },
  { value: "3600", label: "For 1 hour" },
  { value: "14400", label: "For 4 hours" },
  { value: "28800", label: "For 8 hours" },
  { value: "86400", label: "For 24 hours" },
];

export async function themeNames(appearance: "dark" | "light"): Promise<string[]> {
  const all = await loadBundledThemes();
  return all
    .filter((theme) => theme.appearance === appearance)
    .map((theme) => theme.name)
    .sort((a, b) => a.localeCompare(b));
}
