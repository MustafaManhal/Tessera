import { describe, expect, it } from "vitest";
import { clampFontSize, DEFAULT_THEMES, FONT_SIZE, toXtermOptions } from "../../src/engine";

describe("toXtermOptions", () => {
  it("maps only the options given", () => {
    expect(toXtermOptions({})).toEqual({});
    expect(toXtermOptions({ cursorBlink: true })).toEqual({ cursorBlink: true });
  });

  it("clamps font size, line height and scrollback", () => {
    expect(toXtermOptions({ fontSize: 2 }).fontSize).toBe(FONT_SIZE.min);
    expect(toXtermOptions({ fontSize: 99 }).fontSize).toBe(FONT_SIZE.max);
    expect(toXtermOptions({ lineHeight: 0.5 }).lineHeight).toBe(1);
    expect(toXtermOptions({ lineHeight: 3 }).lineHeight).toBe(2);
    expect(toXtermOptions({ scrollback: -5 }).scrollback).toBe(0);
    expect(toXtermOptions({ scrollback: 10_000.4 }).scrollback).toBe(10_000);
  });

  it("makes the unfocused cursor hollow whatever the style", () => {
    for (const style of ["block", "bar", "underline"] as const) {
      expect(toXtermOptions({ cursorStyle: style })).toEqual({ cursorStyle: style, cursorInactiveStyle: "outline" });
    }
  });

  it("passes the theme and leaves out what xterm does not take directly (renderer, ligatures)", () => {
    const mapped = toXtermOptions({ theme: DEFAULT_THEMES.dark, renderer: "dom", ligatures: true });
    expect(mapped).toEqual({ theme: DEFAULT_THEMES.dark });
  });
});

describe("clampFontSize", () => {
  it("rounds, clamps to 8–40 and falls back for garbage", () => {
    expect(clampFontSize(13.4)).toBe(13);
    expect(clampFontSize(7)).toBe(8);
    expect(clampFontSize(41)).toBe(40);
    expect(clampFontSize(Number.NaN)).toBe(13);
  });
});

describe("default themes", () => {
  it("define every colour in both palettes", () => {
    expect(Object.keys(DEFAULT_THEMES.light).sort()).toEqual(Object.keys(DEFAULT_THEMES.dark).sort());
    expect(Object.keys(DEFAULT_THEMES.light)).toHaveLength(21);
  });
});
