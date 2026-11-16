import { describe, expect, it } from "vitest";
import {
  allowedInTextField,
  chordId,
  isComposing,
  keyCode,
  type KeyLike,
  matchesChord,
  parseChord,
} from "../../src/actions/keys";
import { matchBinding, resolveBindings } from "../../src/actions/shortcuts";

const key = (code: string, mods: Partial<Omit<KeyLike, "code">> = {}): KeyLike => ({
  code,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  ...mods,
});

describe("keyCode", () => {
  it("maps letters, digits, punctuation, named keys and F-keys to KeyboardEvent.code", () => {
    expect(keyCode("t")).toBe("KeyT");
    expect(keyCode("9")).toBe("Digit9");
    expect(keyCode("[")).toBe("BracketLeft");
    expect(keyCode("/")).toBe("Slash");
    expect(keyCode("=")).toBe("Equal");
    expect(keyCode("Enter")).toBe("Enter");
    expect(keyCode("Left")).toBe("ArrowLeft");
    expect(keyCode("F4")).toBe("F4");
  });

  it("returns null for keys it does not know", () => {
    expect(keyCode("Hyper")).toBeNull();
    expect(keyCode("F25")).toBeNull();
  });
});

describe("parseChord", () => {
  it("reads Mod as Command on macOS and Ctrl elsewhere", () => {
    expect(parseChord("Mod+Shift+P", "mac")).toEqual({
      code: "KeyP",
      meta: true,
      ctrl: false,
      alt: false,
      shift: true,
    });
    expect(parseChord("Mod+Shift+P", "windows")).toEqual({
      code: "KeyP",
      meta: false,
      ctrl: true,
      alt: false,
      shift: true,
    });
    expect(chordId(parseChord("Ctrl+Alt+Left", "other") ?? ({} as never))).toBe("ctrl+alt+ArrowLeft");
  });

  it("maps the + chord to the shifted Equal physical key", () => {
    const chord = parseChord("Mod++", "windows");
    if (!chord) throw new Error("no chord");
    expect(chord).toMatchObject({ code: "Equal", ctrl: true, shift: true });
    expect(matchesChord(key("Equal", { ctrlKey: true, shiftKey: true }), chord)).toBe(true);
    expect(matchesChord(key("Equal", { ctrlKey: true }), chord)).toBe(false);
  });

  it("rejects an unknown modifier or key", () => {
    expect(parseChord("Hyper+K", "mac")).toBeNull();
    expect(parseChord("Mod+Nope", "mac")).toBeNull();
    expect(parseChord("", "mac")).toBeNull();
  });
});

describe("matchesChord", () => {
  const chord = parseChord("Mod+Shift+D", "mac");
  it("matches the physical key with exactly these modifiers", () => {
    if (!chord) throw new Error("no chord");
    expect(matchesChord(key("KeyD", { metaKey: true, shiftKey: true }), chord)).toBe(true);
  });

  it("does not match with a missing or extra modifier, or another key", () => {
    if (!chord) throw new Error("no chord");
    expect(matchesChord(key("KeyD", { metaKey: true }), chord)).toBe(false);
    expect(matchesChord(key("KeyD", { metaKey: true, shiftKey: true, altKey: true }), chord)).toBe(false);
    expect(matchesChord(key("KeyE", { metaKey: true, shiftKey: true }), chord)).toBe(false);
  });
});

describe("text fields", () => {
  it("allow chords with the command modifier that are not editing keys", () => {
    const allowed = (shortcut: string, platform: "mac" | "windows") => {
      const chord = parseChord(shortcut, platform);
      if (!chord) throw new Error(shortcut);
      return allowedInTextField(chord, platform);
    };
    expect(allowed("Mod+K", "mac")).toBe(true);
    expect(allowed("Ctrl+Shift+P", "windows")).toBe(true);
    // Plain keys, Alt and Shift chords type text; Mod+A/C/V/X/Z and Mod+arrows edit it.
    expect(allowed("F2", "mac")).toBe(false);
    expect(allowed("Alt+Shift+Left", "mac")).toBe(false);
    expect(allowed("Mod+A", "mac")).toBe(false);
    expect(allowed("Mod+V", "windows")).toBe(false);
    expect(allowed("Mod+Alt+Left", "mac")).toBe(false);
    // Ctrl on macOS is not the command modifier (Ctrl+A moves the caret in a Mac text field).
    expect(allowed("Ctrl+Tab", "mac")).toBe(false);
  });
});

describe("isComposing", () => {
  it("is true while an input method composes", () => {
    expect(isComposing({ isComposing: true })).toBe(true);
    expect(isComposing({ isComposing: false, keyCode: 229 })).toBe(true);
    expect(isComposing({ isComposing: false, keyCode: 84 })).toBe(false);
  });
});

describe("matchBinding", () => {
  const mac = resolveBindings("mac");
  const pc = resolveBindings("windows");
  const anywhere = { inText: false, inDialog: false, inTabStrip: false };

  it("finds the action for a chord on each platform", () => {
    expect(matchBinding(key("KeyT", { metaKey: true }), anywhere, mac, "mac")?.action.id).toBe("tab.new");
    expect(matchBinding(key("KeyT", { ctrlKey: true, shiftKey: true }), anywhere, pc, "windows")?.action.id).toBe(
      "tab.new",
    );
    expect(matchBinding(key("KeyE", { ctrlKey: true, shiftKey: true }), anywhere, pc, "windows")?.action.id).toBe(
      "pane.splitDown",
    );
  });

  it("does not take a plain Ctrl key on Windows (it belongs to the shell)", () => {
    expect(matchBinding(key("KeyT", { ctrlKey: true }), anywhere, pc, "windows")).toBeNull();
    expect(matchBinding(key("KeyC", { ctrlKey: true }), anywhere, pc, "windows")).toBeNull();
  });

  it("ignores keys while an input method composes", () => {
    const event = { ...key("KeyT", { metaKey: true }), isComposing: true };
    expect(matchBinding(event, anywhere, mac, "mac")).toBeNull();
  });

  it("keeps out of text fields unless the chord uses the command modifier", () => {
    const inText = { ...anywhere, inText: true };
    expect(matchBinding(key("KeyK", { metaKey: true }), inText, mac, "mac")?.action.id).toBe("view.palette");
    expect(matchBinding(key("ArrowLeft", { metaKey: true, altKey: true }), inText, mac, "mac")).toBeNull();
  });

  it("only lets dialog-aware actions fire inside a dialog", () => {
    const inDialog = { ...anywhere, inDialog: true };
    expect(matchBinding(key("KeyT", { metaKey: true }), inDialog, mac, "mac")).toBeNull();
    expect(matchBinding(key("KeyK", { metaKey: true }), inDialog, mac, "mac")?.action.id).toBe("view.palette");
  });

  it("scopes Delete, F2 and Alt+Shift+arrows to the tab strip", () => {
    const strip = { ...anywhere, inTabStrip: true };
    expect(matchBinding(key("F2"), anywhere, mac, "mac")).toBeNull();
    expect(matchBinding(key("F2"), strip, mac, "mac")?.action.id).toBe("tab.rename");
    expect(matchBinding(key("Delete"), strip, pc, "windows")?.action.id).toBe("tab.close");
    expect(matchBinding(key("Backspace"), strip, mac, "mac")?.action.id).toBe("tab.close");
    expect(matchBinding(key("ArrowRight", { altKey: true, shiftKey: true }), strip, mac, "mac")?.action.id).toBe(
      "tab.moveRight",
    );
    expect(matchBinding(key("ArrowRight", { altKey: true, shiftKey: true }), anywhere, mac, "mac")).toBeNull();
  });
});
