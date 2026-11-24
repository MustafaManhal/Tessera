// Keyboard chords: parsing "Mod+Shift+P" into a matcher on `KeyboardEvent.code` (the physical key, so shortcuts
// stay where they are on any keyboard layout), and the rule that keeps shortcuts out of text fields.
import type { Platform } from "@tessera/ui";

export interface Chord {
  code: string;
  meta: boolean;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
}

const NAMED_CODES: Record<string, string> = {
  enter: "Enter",
  return: "Enter",
  tab: "Tab",
  escape: "Escape",
  esc: "Escape",
  space: "Space",
  backspace: "Backspace",
  delete: "Delete",
  del: "Delete",
  home: "Home",
  end: "End",
  pageup: "PageUp",
  pagedown: "PageDown",
  left: "ArrowLeft",
  right: "ArrowRight",
  up: "ArrowUp",
  down: "ArrowDown",
  arrowleft: "ArrowLeft",
  arrowright: "ArrowRight",
  arrowup: "ArrowUp",
  arrowdown: "ArrowDown",
  "[": "BracketLeft",
  "]": "BracketRight",
  "/": "Slash",
  "\\": "Backslash",
  ",": "Comma",
  ".": "Period",
  ";": "Semicolon",
  "'": "Quote",
  "`": "Backquote",
  "=": "Equal",
  "-": "Minus",
  "+": "Equal",
};

/** The `KeyboardEvent.code` for a key name, or null when we do not know it. */
export function keyCode(key: string): string | null {
  if (/^[a-z]$/i.test(key)) return `Key${key.toUpperCase()}`;
  if (/^[0-9]$/.test(key)) return `Digit${key}`;
  if (/^f([1-9]|1[0-9]|2[0-4])$/i.test(key)) return key.toUpperCase();
  return NAMED_CODES[key.toLowerCase()] ?? null;
}

/** "Mod+Shift+P" → a chord for this platform; Mod is Command on macOS and Ctrl elsewhere. Null if unreadable. */
export function parseChord(shortcut: string, platform: Platform): Chord | null {
  const parts = shortcut.split("+");
  if (parts.length >= 2 && parts.at(-1) === "" && parts.at(-2) === "") parts.splice(-2, 2, "+");
  const keys = parts.map((p) => p.trim()).filter(Boolean);
  const key = keys.pop();
  if (!key) return null;
  const chord: Chord = { code: "", meta: false, ctrl: false, alt: false, shift: false };
  for (const modifier of keys) {
    switch (modifier.toLowerCase()) {
      case "mod":
        if (platform === "mac") chord.meta = true;
        else chord.ctrl = true;
        break;
      case "cmd":
      case "command":
      case "meta":
        chord.meta = true;
        break;
      case "ctrl":
      case "control":
        chord.ctrl = true;
        break;
      case "alt":
      case "option":
      case "opt":
        chord.alt = true;
        break;
      case "shift":
        chord.shift = true;
        break;
      default:
        return null;
    }
  }
  const code = keyCode(key);
  if (!code) return null;
  chord.code = code;
  if (key === "+") chord.shift = true;
  return chord;
}

export interface KeyLike {
  code: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

export function matchesChord(event: KeyLike, chord: Chord): boolean {
  return (
    event.code === chord.code &&
    event.metaKey === chord.meta &&
    event.ctrlKey === chord.ctrl &&
    event.altKey === chord.alt &&
    event.shiftKey === chord.shift
  );
}

/** A canonical string for comparing chords ("meta+shift+KeyP"). */
export function chordId(chord: Chord): string {
  return [chord.meta && "meta", chord.ctrl && "ctrl", chord.alt && "alt", chord.shift && "shift", chord.code]
    .filter(Boolean)
    .join("+");
}

const TEXT_INPUT_TYPES = new Set(["", "text", "search", "url", "email", "password", "number", "tel"]);

/**
 * True when keys typed here are text: an editable input, a textarea, a select or contenteditable. A terminal
 * (anything inside `[data-terminal]`) is not a text field: the global shortcuts must keep working there.
 */
export function isTextEntry(target: EventTarget | null): boolean {
  if (!(target instanceof Element) || target.closest("[data-terminal]")) return false;
  if (target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return true;
  if (target instanceof HTMLInputElement) return TEXT_INPUT_TYPES.has(target.type) && !target.readOnly;
  return target instanceof HTMLElement && target.isContentEditable;
}

// Keys a text field uses with the command modifier (select all, copy, cut, paste, undo, redo, caret moves).
const EDITING_CODES = new Set([
  "KeyA",
  "KeyC",
  "KeyV",
  "KeyX",
  "KeyZ",
  "KeyY",
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "ArrowDown",
  "Backspace",
  "Delete",
  "Home",
  "End",
]);

/**
 * Whether a chord may fire while a text field has focus: only when it uses the platform's command modifier
 * (Command on macOS, Ctrl elsewhere), which plain typing never does, and is not one of the field's editing keys.
 */
export function allowedInTextField(chord: Chord, platform: Platform): boolean {
  const command = platform === "mac" ? chord.meta : chord.ctrl;
  return command && !EDITING_CODES.has(chord.code);
}

/** Keys pressed while an input method composes text (CJK, accents) belong to the composition. */
export function isComposing(event: { isComposing?: boolean; keyCode?: number }): boolean {
  return event.isComposing === true || event.keyCode === 229;
}
