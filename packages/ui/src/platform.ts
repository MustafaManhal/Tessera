// Platform detection and shortcut formatting. Shortcuts are written once, platform-neutral ("Mod+Shift+P"), and
// shown per platform: glyphs on macOS (⌘⇧P), words joined with "+" on Windows and Linux (Ctrl+Shift+P).
import { type StringKey, t } from "./strings";

export type Platform = "mac" | "windows" | "other";

/** Reads the platform from the user agent; no Tauri call, so it works in tests and the browser gallery. */
export function getPlatform(userAgent: string = globalThis.navigator?.userAgent ?? ""): Platform {
  if (/Macintosh|Mac OS X|iPhone|iPad/.test(userAgent)) return "mac";
  if (/Windows/.test(userAgent)) return "windows";
  return "other";
}

// A label is a glyph shown as is, or a catalog key (they all start with "key.").
type Label = string;

interface KeyDef {
  /** Shown on macOS. */
  mac: Label;
  /** Shown on Windows and Linux. */
  pc: Label;
  /** Read by screen readers on macOS. */
  macSpoken: StringKey;
  /** Read by screen readers on Windows and Linux. */
  pcSpoken: StringKey;
}

const KEYS: Record<string, KeyDef> = {
  // Mod is the platform's main modifier: Command on macOS, Ctrl elsewhere.
  mod: { mac: "⌘", pc: "key.ctrl", macSpoken: "key.spoken.command", pcSpoken: "key.ctrl" },
  meta: { mac: "⌘", pc: "key.win", macSpoken: "key.spoken.command", pcSpoken: "key.spoken.windows" },
  ctrl: { mac: "⌃", pc: "key.ctrl", macSpoken: "key.spoken.control", pcSpoken: "key.ctrl" },
  alt: { mac: "⌥", pc: "key.alt", macSpoken: "key.spoken.option", pcSpoken: "key.alt" },
  shift: { mac: "⇧", pc: "key.shift", macSpoken: "key.shift", pcSpoken: "key.shift" },
  enter: { mac: "↩", pc: "key.enter", macSpoken: "key.spoken.return", pcSpoken: "key.enter" },
  escape: { mac: "key.esc", pc: "key.esc", macSpoken: "key.spoken.escape", pcSpoken: "key.spoken.escape" },
  tab: { mac: "⇥", pc: "key.tab", macSpoken: "key.tab", pcSpoken: "key.tab" },
  space: { mac: "key.space", pc: "key.space", macSpoken: "key.space", pcSpoken: "key.space" },
  backspace: { mac: "⌫", pc: "key.backspace", macSpoken: "key.spoken.delete", pcSpoken: "key.backspace" },
  delete: { mac: "⌦", pc: "key.del", macSpoken: "key.spoken.forwardDelete", pcSpoken: "key.spoken.delete" },
  up: { mac: "↑", pc: "↑", macSpoken: "key.spoken.up", pcSpoken: "key.spoken.up" },
  down: { mac: "↓", pc: "↓", macSpoken: "key.spoken.down", pcSpoken: "key.spoken.down" },
  left: { mac: "←", pc: "←", macSpoken: "key.spoken.left", pcSpoken: "key.spoken.left" },
  right: { mac: "→", pc: "→", macSpoken: "key.spoken.right", pcSpoken: "key.spoken.right" },
  home: { mac: "↖", pc: "key.home", macSpoken: "key.home", pcSpoken: "key.home" },
  end: { mac: "↘", pc: "key.end", macSpoken: "key.end", pcSpoken: "key.end" },
  pageup: { mac: "⇞", pc: "key.pageUp", macSpoken: "key.spoken.pageUp", pcSpoken: "key.spoken.pageUp" },
  pagedown: { mac: "⇟", pc: "key.pageDown", macSpoken: "key.spoken.pageDown", pcSpoken: "key.spoken.pageDown" },
};

// Other spellings people write in shortcuts, lower-cased.
const ALIASES: Record<string, string> = {
  cmd: "meta",
  command: "meta",
  super: "meta",
  win: "meta",
  control: "ctrl",
  option: "alt",
  opt: "alt",
  return: "enter",
  esc: "escape",
  del: "delete",
  arrowup: "up",
  arrowdown: "down",
  arrowleft: "left",
  arrowright: "right",
};

function label(value: Label): string {
  return value.startsWith("key.") ? t(value as StringKey) : value;
}

/** Splits "Mod+Shift+P" into its keys. "Mod++" is Mod and the "+" key. */
export function splitShortcut(shortcut: string): string[] {
  const parts = shortcut.split("+");
  // A trailing "++" splits into two empty strings: together they are the "+" key.
  if (parts.length >= 2 && parts.at(-1) === "" && parts.at(-2) === "") parts.splice(-2, 2, "+");
  return parts.map((part) => part.trim()).filter((part) => part !== "");
}

function keyDef(key: string): KeyDef | undefined {
  const lower = key.toLowerCase();
  return KEYS[ALIASES[lower] ?? lower];
}

/** A single letter shows in capitals (Mod+k → ⌘K); any other key we do not know passes through unchanged. */
function plainKey(key: string): string {
  return key.length === 1 ? key.toUpperCase() : key;
}

/** "Mod+Shift+P" → "⌘⇧P" on macOS, "Ctrl+Shift+P" on Windows and Linux. Keys keep the order they are written in. */
export function formatShortcut(shortcut: string, platform: Platform = getPlatform()): string {
  const keys = splitShortcut(shortcut).map((key) => {
    const def = keyDef(key);
    if (!def) return plainKey(key);
    return label(platform === "mac" ? def.mac : def.pc);
  });
  return keys.join(platform === "mac" ? "" : "+");
}

/** The words a screen reader should say for a shortcut: "Command Shift P", "Ctrl Shift P". */
export function describeShortcut(shortcut: string, platform: Platform = getPlatform()): string {
  return splitShortcut(shortcut)
    .map((key) => {
      const def = keyDef(key);
      if (!def) return plainKey(key);
      return t(platform === "mac" ? def.macSpoken : def.pcSpoken);
    })
    .join(" ");
}
