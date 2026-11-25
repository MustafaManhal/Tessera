// Config keys (config.toml, the Rust side) ↔ the Redux `settings.terminal` slice the terminal reads. The screen edits
// config keys; `config:changed` flows through `configToTerminal` into the slice; a change made inside the app
// (font zoom, "turn on ligatures", "Always allow" for OSC 52) flows back through `terminalPatchToConfig`.
//
// Slice keys with no config key yet (they stay app-local, see the brief 10 report): renderer, fontWeight,
// trimTrailingWhitespace, middleClickPaste, images, blockGutter, longCommandAlert's separate switch,
// secureKeyboardEntry, notifications (programs), pasteConfirm "always".
import type { Osc52Policy } from "@tessera/term";
import type { TerminalSettings } from "../store/settingsSlice";
import { getValue, patchFor } from "./schema";

export type ConfigPatch = Record<string, Record<string, unknown>>;

const num = (value: unknown, fallback: number) =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;
const bool = (value: unknown, fallback: boolean) => (typeof value === "boolean" ? value : fallback);

/** The slice fields a config object decides; the rest of `current` is kept. */
export function configToTerminal(config: unknown, current: TerminalSettings): Partial<TerminalSettings> {
  const out: Partial<TerminalSettings> = {};
  const family = getValue(config, "font.family");
  if (typeof family === "string" && family.trim() !== "") out.fontFamily = family;
  out.fontSize = num(getValue(config, "font.size"), current.fontSize);
  out.lineHeight = num(getValue(config, "font.line-height"), current.lineHeight);
  out.ligatures = bool(getValue(config, "font.ligatures"), current.ligatures);
  const cursor = getValue(config, "terminal.cursor-style");
  if (cursor === "block" || cursor === "bar" || cursor === "underline") out.cursorStyle = cursor;
  out.cursorBlink = bool(getValue(config, "terminal.cursor-blink"), current.cursorBlink);
  out.scrollback = num(getValue(config, "terminal.scrollback"), current.scrollback);
  out.copyOnSelect = bool(getValue(config, "terminal.copy-on-select"), current.copyOnSelect);
  const confirm = bool(getValue(config, "terminal.confirm-multiline-paste"), current.pasteConfirm !== "never");
  // "always" is app-only: keep it while the config still says "ask".
  out.pasteConfirm = confirm ? (current.pasteConfirm === "always" ? "always" : "multiline") : "never";
  const osc52 = getValue(config, "terminal.osc52");
  if (osc52 === "off") out.osc52Write = "deny";
  else if (osc52 === "ask" || osc52 === "allow") out.osc52Write = osc52 as Osc52Policy;
  const seconds = num(getValue(config, "terminal.long-command-notify-seconds"), current.longCommandSeconds);
  // 0 turns the alert off (schema: "Notify when commands exceed this duration"; zero means never).
  out.longCommandAlert = seconds > 0;
  if (seconds > 0) out.longCommandSeconds = seconds;
  return out;
}

/** The config patch for slice changes (only keys that map); null when none do. */
export function terminalPatchToConfig(before: TerminalSettings, after: TerminalSettings): ConfigPatch | null {
  const patch: ConfigPatch = {};
  const add = (key: string, value: unknown) => {
    const part = patchFor(key, value);
    for (const [section, values] of Object.entries(part)) patch[section] = { ...patch[section], ...values };
  };
  if (before.fontFamily !== after.fontFamily) add("font.family", after.fontFamily);
  if (before.fontSize !== after.fontSize) add("font.size", after.fontSize);
  if (before.lineHeight !== after.lineHeight) add("font.line-height", after.lineHeight);
  if (before.ligatures !== after.ligatures) add("font.ligatures", after.ligatures);
  if (before.cursorStyle !== after.cursorStyle) add("terminal.cursor-style", after.cursorStyle);
  if (before.cursorBlink !== after.cursorBlink) add("terminal.cursor-blink", after.cursorBlink);
  if (before.scrollback !== after.scrollback) add("terminal.scrollback", after.scrollback);
  if (before.copyOnSelect !== after.copyOnSelect) add("terminal.copy-on-select", after.copyOnSelect);
  if (before.pasteConfirm !== after.pasteConfirm && (before.pasteConfirm === "never" || after.pasteConfirm === "never"))
    add("terminal.confirm-multiline-paste", after.pasteConfirm !== "never");
  if (before.osc52Write !== after.osc52Write)
    add("terminal.osc52", after.osc52Write === "deny" ? "off" : after.osc52Write);
  if ((before.longCommandSeconds !== after.longCommandSeconds || !before.longCommandAlert) && after.longCommandAlert)
    add("terminal.long-command-notify-seconds", after.longCommandSeconds);
  if (before.longCommandAlert !== after.longCommandAlert && !after.longCommandAlert)
    add("terminal.long-command-notify-seconds", 0);
  return Object.keys(patch).length > 0 ? patch : null;
}
