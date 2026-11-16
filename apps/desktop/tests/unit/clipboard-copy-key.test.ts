import { describe, expect, it } from "vitest";
import { nativeClipboardKey } from "../../src/terminal/clipboard";

const key = (code: string, mods: Partial<Record<"ctrlKey" | "shiftKey" | "altKey" | "metaKey", boolean>> = {}) => ({
  code,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  metaKey: false,
  ...mods,
});

describe("Ctrl+C and Ctrl+V on Windows", () => {
  it("Ctrl+C copies a selection and interrupts without one", () => {
    expect(nativeClipboardKey(key("KeyC", { ctrlKey: true }), true, "windows")).toBe("copy");
    expect(nativeClipboardKey(key("KeyC", { ctrlKey: true }), false, "windows")).toBeNull();
  });

  it("Ctrl+V pastes, with or without a selection", () => {
    expect(nativeClipboardKey(key("KeyV", { ctrlKey: true }), false, "windows")).toBe("paste");
    expect(nativeClipboardKey(key("KeyV", { ctrlKey: true }), true, "windows")).toBe("paste");
  });

  it("leaves other chords and macOS alone", () => {
    expect(nativeClipboardKey(key("KeyC", { ctrlKey: true, shiftKey: true }), true, "windows")).toBeNull();
    expect(nativeClipboardKey(key("KeyV", { ctrlKey: true, altKey: true }), true, "windows")).toBeNull();
    expect(nativeClipboardKey(key("KeyX", { ctrlKey: true }), true, "windows")).toBeNull();
    expect(nativeClipboardKey(key("KeyC"), true, "windows")).toBeNull();
    expect(nativeClipboardKey(key("KeyC", { ctrlKey: true }), true, "mac")).toBeNull();
    expect(nativeClipboardKey(key("KeyV", { ctrlKey: true }), true, "mac")).toBeNull();
  });
});
