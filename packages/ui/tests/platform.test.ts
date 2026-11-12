import { describe, expect, it } from "vitest";
import { describeShortcut, formatShortcut, getPlatform, splitShortcut } from "../src/platform";

const MAC_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)";
const WINDOWS_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36 Edg/138.0.0.0";
const LINUX_UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36";

describe("getPlatform", () => {
  it("reads macOS, Windows and anything else from the user agent", () => {
    expect(getPlatform(MAC_UA)).toBe("mac");
    expect(getPlatform(WINDOWS_UA)).toBe("windows");
    expect(getPlatform(LINUX_UA)).toBe("other");
    expect(getPlatform("")).toBe("other");
  });
});

describe("formatShortcut", () => {
  it("uses glyphs on macOS", () => {
    expect(formatShortcut("Mod+Shift+P", "mac")).toBe("⌘⇧P");
    expect(formatShortcut("Ctrl+Alt+Enter", "mac")).toBe("⌃⌥↩");
    expect(formatShortcut("Mod+Backspace", "mac")).toBe("⌘⌫");
    expect(formatShortcut("Escape", "mac")).toBe("Esc");
  });

  it("uses words joined with + on Windows and Linux", () => {
    expect(formatShortcut("Mod+Shift+P", "windows")).toBe("Ctrl+Shift+P");
    expect(formatShortcut("Mod+Shift+P", "other")).toBe("Ctrl+Shift+P");
    expect(formatShortcut("Alt+ArrowUp", "windows")).toBe("Alt+↑");
    expect(formatShortcut("Mod+Shift+Delete", "windows")).toBe("Ctrl+Shift+Del");
  });

  it("accepts other spellings and lower-case letters", () => {
    expect(formatShortcut("cmd+option+k", "mac")).toBe("⌘⌥K");
    expect(formatShortcut("Control+Return", "windows")).toBe("Ctrl+Enter");
    expect(formatShortcut("Cmd+K", "windows")).toBe("Win+K");
  });

  it("handles the + key itself", () => {
    expect(splitShortcut("Mod++")).toEqual(["Mod", "+"]);
    expect(formatShortcut("Mod+Shift++", "mac")).toBe("⌘⇧+");
    expect(formatShortcut("Mod+=", "windows")).toBe("Ctrl+=");
  });

  it("passes an unknown key through unchanged", () => {
    expect(formatShortcut("Hyper", "mac")).toBe("Hyper");
    expect(formatShortcut("Mod+Foo", "mac")).toBe("⌘Foo");
    expect(formatShortcut("Mod+F13", "windows")).toBe("Ctrl+F13");
    expect(formatShortcut("Shift+NotAKey", "windows")).toBe("Shift+NotAKey");
    expect(formatShortcut("Mod+Foo", "mac")).not.toBe("⌘FOO");
  });

  it("defaults to the running platform", () => {
    expect(formatShortcut("Mod+B")).toBe(formatShortcut("Mod+B", getPlatform()));
  });
});

describe("describeShortcut", () => {
  it("spells keys out for screen readers", () => {
    expect(describeShortcut("Mod+Shift+P", "mac")).toBe("Command Shift P");
    expect(describeShortcut("Mod+Shift+P", "windows")).toBe("Ctrl Shift P");
    expect(describeShortcut("Escape", "mac")).toBe("Escape");
    expect(describeShortcut("Alt+ArrowDown", "mac")).toBe("Option Down Arrow");
  });
});
