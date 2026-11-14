import { describe, expect, it } from "vitest";
import { ACCENT_PRESETS, DEFAULT_ACCENT, deriveAccent, mixHex } from "../../src/themes/accent";
import { contrastOf } from "../../src/themes/model";

describe("accent colour", () => {
  it("baby blue is the default", () => {
    expect(DEFAULT_ACCENT).toBe("#89cff0");
    expect(ACCENT_PRESETS[0]?.fill).toBe(DEFAULT_ACCENT);
  });

  it("derives readable text, ink and button label for every preset in both modes", () => {
    for (const preset of ACCENT_PRESETS) {
      for (const mode of ["light", "dark"] as const) {
        const { accent, fg, ink } = deriveAccent(preset.fill, mode);
        const surface = mode === "light" ? "#e8e8e8" : "#1f1f1f";
        expect(contrastOf(fg, accent), `${preset.id} ${mode} label`).toBeGreaterThanOrEqual(4.5);
        expect(contrastOf(ink, surface), `${preset.id} ${mode} ink`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it("handles colours that are very light or very dark", () => {
    for (const fill of ["#ffffff", "#000000", "#ffff00", "#0000ff"]) {
      const light = deriveAccent(fill, "light");
      const dark = deriveAccent(fill, "dark");
      expect(contrastOf(light.ink, "#e8e8e8")).toBeGreaterThanOrEqual(4.5);
      expect(contrastOf(dark.ink, "#1f1f1f")).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("mixes toward a target", () => {
    expect(mixHex("#000000", "#ffffff", 0.5)).toBe("#808080");
  });
});
