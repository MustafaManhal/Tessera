// Chords as text (FR-67): parse, normalise and format the strings the config and the recorder use ("Mod+Shift+P"), and
// turn a key press into one. Pure and platform-free; `keys.ts` turns the text into a matcher for a platform.
//
// Spellings: modifiers are case-insensitive and may come in any order (Mod, Cmd/Command/Super/Win/Meta, Ctrl/Control,
// Alt/Option/Opt, Shift). The key is a letter, digit, F1–F24, a named key (Enter, Esc, Up, PageDown, …) or punctuation;
// "+" is written as "+" at the end ("Mod++") or "Plus". Canonical order: Mod, Cmd, Ctrl, Alt, Shift, key.
import type { Platform } from "@tessera/ui";

export interface ChordSpec {
  /** The platform's main modifier: Command on macOS, Ctrl elsewhere. */
  mod: boolean;
  /** The literal Command / Windows key. */
  meta: boolean;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  /** Canonical key name: "P", "1", "F2", "Up", "Enter", ",", "+". */
  key: string;
}

const MODIFIER_ALIASES: Record<string, "mod" | "meta" | "ctrl" | "alt" | "shift"> = {
  mod: "mod",
  cmd: "meta",
  command: "meta",
  meta: "meta",
  super: "meta",
  win: "meta",
  windows: "meta",
  ctrl: "ctrl",
  control: "ctrl",
  alt: "alt",
  option: "alt",
  opt: "alt",
  shift: "shift",
};

const NAMED: Record<string, string> = {
  enter: "Enter",
  return: "Enter",
  tab: "Tab",
  escape: "Escape",
  esc: "Escape",
  space: "Space",
  spacebar: "Space",
  backspace: "Backspace",
  delete: "Delete",
  del: "Delete",
  home: "Home",
  end: "End",
  pageup: "PageUp",
  pagedown: "PageDown",
  up: "Up",
  down: "Down",
  left: "Left",
  right: "Right",
  arrowup: "Up",
  arrowdown: "Down",
  arrowleft: "Left",
  arrowright: "Right",
  plus: "+",
  minus: "-",
  comma: ",",
  period: ".",
  slash: "/",
  backslash: "\\",
};

const PUNCTUATION = new Set(["[", "]", "/", "\\", ",", ".", ";", "'", "`", "=", "-", "+"]);

/** The canonical key name for text, or null when it is not a key we know. */
export function normalizeKey(text: string): string | null {
  if (/^[a-z]$/i.test(text)) return text.toUpperCase();
  if (/^[0-9]$/.test(text)) return text;
  if (/^f([1-9]|1[0-9]|2[0-4])$/i.test(text)) return text.toUpperCase();
  const named = NAMED[text.toLowerCase()];
  if (named) return named;
  return PUNCTUATION.has(text) ? text : null;
}

/** Parses "cmd+shift+p" into a spec; null for empty text, an unknown modifier or key, two keys, or no key. */
export function parseChordText(text: string): ChordSpec | null {
  if (typeof text !== "string") return null;
  const parts = text.trim().split("+");
  // "Mod++" splits into [..., "", ""]: the two empties are the "+" key.
  if (parts.length >= 2 && parts.at(-1) === "" && parts.at(-2) === "") parts.splice(-2, 2, "+");
  const tokens = parts.map((part) => part.trim());
  if (tokens.length === 0 || tokens.some((token) => token === "")) return null;
  const keyText = tokens.pop() as string;
  const spec: ChordSpec = { mod: false, meta: false, ctrl: false, alt: false, shift: false, key: "" };
  for (const token of tokens) {
    const modifier = MODIFIER_ALIASES[token.toLowerCase()];
    if (!modifier) return null;
    if (spec[modifier]) return null; // the same modifier twice
    spec[modifier] = true;
  }
  let key = normalizeKey(keyText);
  if (!key) return null;
  if (key === "+") spec.shift = false;
  else if (key === "=" && spec.shift) {
    key = "+";
    spec.shift = false;
  }
  spec.key = key;
  return spec;
}

/** "Mod+Cmd+Ctrl+Alt+Shift+Key" with only the modifiers that are set. */
export function formatChord(spec: ChordSpec): string {
  return [
    spec.mod && "Mod",
    spec.meta && "Cmd",
    spec.ctrl && "Ctrl",
    spec.alt && "Alt",
    spec.shift && "Shift",
    spec.key,
  ]
    .filter(Boolean)
    .join("+");
}

/** The canonical text of a chord, or null when it cannot be read. */
export function normalizeChord(text: string): string | null {
  const spec = parseChordText(text);
  return spec ? formatChord(spec) : null;
}

/** The chord with Mod spelled out for a platform (Cmd on macOS, Ctrl elsewhere), so "Mod+T" and "Ctrl+T" compare equal on Windows. */
export function canonicalFor(text: string, platform: Platform): string | null {
  const spec = parseChordText(text);
  if (!spec) return null;
  if (spec.mod) {
    if (platform === "mac") spec.meta = true;
    else spec.ctrl = true;
    spec.mod = false;
  }
  return formatChord(spec);
}

/** True when two texts spell the same chord. */
export function sameChord(a: string, b: string): boolean {
  const left = normalizeChord(a);
  return left !== null && left === normalizeChord(b);
}

const CODE_KEYS: Record<string, string> = {
  Enter: "Enter",
  NumpadEnter: "Enter",
  Tab: "Tab",
  Escape: "Escape",
  Space: "Space",
  Backspace: "Backspace",
  Delete: "Delete",
  Home: "Home",
  End: "End",
  PageUp: "PageUp",
  PageDown: "PageDown",
  ArrowUp: "Up",
  ArrowDown: "Down",
  ArrowLeft: "Left",
  ArrowRight: "Right",
  BracketLeft: "[",
  BracketRight: "]",
  Slash: "/",
  Backslash: "\\",
  Comma: ",",
  Period: ".",
  Semicolon: ";",
  Quote: "'",
  Backquote: "`",
  Equal: "=",
  Minus: "-",
};

export interface RecordedKey {
  code: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

/**
 * The chord a key press records, or null for a modifier on its own or an unknown key. The platform's main modifier is
 * written "Mod" so the same config works on both systems: Command on macOS, Ctrl on Windows. Ctrl on macOS and the
 * Windows key on Windows stay literal.
 */
export function chordFromEvent(event: RecordedKey, platform: Platform): ChordSpec | null {
  let key: string | undefined;
  if (/^Key[A-Z]$/.test(event.code)) key = event.code.slice(3);
  else if (/^Digit[0-9]$/.test(event.code)) key = event.code.slice(5);
  else if (/^F([1-9]|1[0-9]|2[0-4])$/.test(event.code)) key = event.code;
  else key = CODE_KEYS[event.code];
  if (!key) return null;
  if (key === "=" && event.shiftKey) key = "+";
  const mac = platform === "mac";
  return {
    mod: mac ? event.metaKey : event.ctrlKey,
    meta: mac ? false : event.metaKey,
    ctrl: mac ? event.ctrlKey : false,
    alt: event.altKey,
    shift: event.shiftKey && key !== "+",
    key,
  };
}
