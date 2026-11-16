import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { appearanceVariables, dimUnfocused, terminalPadding, windowOpacity } from "../../src/themes/appearance";

describe("appearance settings", () => {
  it("maps valid window opacity to a CSS variable and clamps out-of-range values", () => {
    expect(appearanceVariables({ appearance: { "window-opacity": 0.65 } })).toEqual({
      "--window-opacity": "0.65",
      "--terminal-padding": "6px",
    });
    expect(windowOpacity({ appearance: { "window-opacity": -1 } })).toBe(0);
    expect(windowOpacity({ appearance: { "window-opacity": 2 } })).toBe(1);
    expect(windowOpacity({ appearance: { "window-opacity": Number.NaN } })).toBe(1);
    expect(windowOpacity(null)).toBe(1);
  });

  it("maps padding to pixels and dimming to 0..0.6, with safe defaults for bad config", () => {
    expect(appearanceVariables({ appearance: { padding: 12 } })["--terminal-padding"]).toBe("12px");
    expect(terminalPadding({ appearance: { padding: -4 } })).toBe(0);
    expect(terminalPadding({ appearance: { padding: 99 } })).toBe(32);
    expect(terminalPadding({ appearance: { padding: 3.6 } })).toBe(4);
    expect(terminalPadding({ appearance: { padding: "x" } })).toBe(6);
    expect(terminalPadding(undefined)).toBe(6);
    expect(dimUnfocused({ appearance: { "dim-unfocused": 0.3 } })).toBe(0.3);
    expect(dimUnfocused({ appearance: { "dim-unfocused": 0.9 } })).toBe(0.6);
    expect(dimUnfocused({ appearance: { "dim-unfocused": -1 } })).toBe(0);
    expect(dimUnfocused({ appearance: { "dim-unfocused": Number.NaN } })).toBe(0);
    expect(dimUnfocused(null)).toBe(0);
  });

  it("emits window opacity and system accessibility rules in the app styles", () => {
    const appStyles = readFileSync(new URL("../../src/styles.css", import.meta.url), "utf8");
    const tokenStyles = readFileSync(new URL("../../../../packages/ui/src/tokens.css", import.meta.url), "utf8");
    expect(appStyles).toContain("opacity: var(--window-opacity, 1)");
    expect(tokenStyles).toContain("--window-opacity: 1");
    expect(tokenStyles).toContain("@media (prefers-reduced-motion: reduce)");
    expect(tokenStyles).toContain("@media (prefers-contrast: more)");
    expect(tokenStyles).toContain("@media (forced-colors: active)");
  });
});
