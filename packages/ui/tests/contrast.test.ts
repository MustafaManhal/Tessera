// Every text and UI token pair the components use, checked against WCAG 2.2 AA for every colour theme
// (src/colorThemes.ts) with the derived tokens of the real tokens.css. Also checks that tokens.css starts out as the
// Tessera Light and Tessera Dark themes. Print the table:
// TOKENS_REPORT=1 pnpm vitest run packages/ui/tests/contrast.test.ts -t prints --reporter=verbose
import { describe, expect, it } from "vitest";
import { ACCENT_PRESETS, COLOR_THEMES, findColorTheme, withAccent } from "../src/colorThemes";
import { AA_TEXT, AA_UI, contrastRatio, mixSrgb, parseColor } from "../src/contrast";
import { type Declarations, parseRules, parseThemeBlock, readSource, resolveColor, rule } from "./css";

const rules = parseRules(readSource("tokens.css"));
const root = rule(rules, ":root");
const light = rule(rules, ':root, [data-theme="light"]');
const dark = rule(rules, '[data-theme="dark"]');
const darkSystem = rule(rules, ':root:not([data-theme="light"])', "@media (prefers-color-scheme: dark)");
const derived = rule(rules, ":root, [data-theme]");

const themes: Record<string, Declarations> = Object.fromEntries(
  COLOR_THEMES.map((theme) => [
    theme.name,
    new Map([...root, ...light, ...Object.entries(theme.variables), ...derived]) as Declarations,
  ]),
);
const highContrast = new Set(COLOR_THEMES.filter((theme) => theme.highContrast).map((theme) => theme.name));

interface Pair {
  fg: string;
  bg: string;
  min: number;
  use: string;
}

const text = (fg: string, bg: string, use: string): Pair => ({ fg, bg, min: AA_TEXT, use });
const ui = (fg: string, bg: string, use: string): Pair => ({ fg, bg, min: AA_UI, use });

const surfaces = ["--bg", "--surface", "--surface-2", "--surface-3", "--sidebar-bg", "--titlebar-bg"];
const statusNames = ["working", "needs", "done", "error", "off"];

export const pairs: Pair[] = [
  ...surfaces.map((bg) => text("--text", bg, "body text")),
  ...surfaces.map((bg) => text("--text-muted", bg, "secondary text, placeholders, Kbd")),
  ...["--accent", "--accent-hover", "--accent-press"].map((bg) => text("--accent-fg", bg, "primary button")),
  ...["--danger", "--danger-hover", "--danger-press"].map((bg) => text("--danger-fg", bg, "danger button")),
  text("--text", "--surface-press", "secondary button, pressed"),
  ...["--bg", "--surface"].map((bg) => text("--danger", bg, "inline form error")),
  ...statusNames.map((s) => text("--text", `--st-${s}-tint`, "status pill label")),
  ...statusNames.flatMap((s) =>
    [...surfaces, `--st-${s}-tint`].map((bg) => ui(`--st-${s}`, bg, "status icon (rows, pills)")),
  ),
  ...["red", "orange", "yellow", "green", "blue", "purple"].flatMap((colour) =>
    surfaces.map((bg) => ui(`--tab-${colour}`, bg, "tab colour dot")),
  ),
  ...surfaces.map((bg) => ui("--focus-ring-color", bg, "focus ring")),
  ...["--bg", "--surface", "--surface-2"].map((bg) => ui("--border-strong", bg, "input, select, switch edge")),
  ...["--bg", "--surface"].map((bg) => ui("--accent-ink", bg, "switch on, info icon")),
  ui("--accent-ink", "--surface-3", "select check on highlighted item"),
  ...surfaces.map((bg) => text("--accent-ink", bg, "accent text: active project, links")),
  ...["--bg", "--surface"].map((bg) => ui("--danger", bg, "invalid field border")),
  ui("--surface", "--accent-ink", "switch thumb, on"),
  ui("--surface", "--border-strong", "switch thumb, off"),
  ...["--statusbar-bg", "--statusbar-hover", "--statusbar-active"].map((bg) =>
    text("--statusbar-fg", bg, "status bar text and icons"),
  ),
  ...["--sidebar-bg", "--surface", "--surface-2"].map((bg) => text("--task-fg", bg, "task name, not in front")),
  ...["--surface-3", "--surface-2"].map((bg) => text("--accent-ink", bg, "task name in front, selected")),
  text("--text", "--accent-soft", "selected nav item, chip"),
];

const ratio = (pair: Pair, vars: Declarations) =>
  contrastRatio(resolveColor(pair.fg, vars), resolveColor(pair.bg, vars));

describe("contrast maths", () => {
  it("matches the WCAG extremes", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 5);
    expect(contrastRatio("#5b5bd6", "#5b5bd6")).toBe(1);
  });

  it("paints a translucent colour over the background", () => {
    const halfBlack = mixSrgb(parseColor("#000000"), parseColor("transparent"), 0.5);
    expect(halfBlack[3]).toBeCloseTo(0.5);
    expect(contrastRatio(halfBlack, "#ffffff")).toBeCloseTo(contrastRatio("#808080", "#ffffff"), 1);
  });

  it("rejects what it cannot read", () => {
    expect(() => parseColor("oklch(0.5 0.1 200)")).toThrow();
    expect(() => contrastRatio("#000", "transparent")).toThrow();
  });

  it("fails the §2 values this task had to change (the check is not vacuous)", () => {
    expect(contrastRatio("#c77a00", "#e4e6ea")).toBeLessThan(AA_UI); // light needs on surface-3
    expect(contrastRatio("#8a8f98", "#e4e6ea")).toBeLessThan(AA_UI); // light off on surface-3
    expect(contrastRatio("#6b7079", "#272a30")).toBeLessThan(AA_UI); // dark off on surface-3
    const ring60 = mixSrgb(parseColor("#5b5bd6"), parseColor("transparent"), 0.6);
    expect(contrastRatio(ring60, "#ffffff")).toBeLessThan(AA_UI); // 60 % focus ring, light
    expect(contrastRatio("#dcdee3", "#ffffff")).toBeLessThan(AA_UI); // --border cannot mark a field's edge
  });
});

describe("tokens.css", () => {
  it("declares the same tokens in light and dark", () => {
    expect([...dark.keys()].sort()).toEqual([...light.keys()].sort());
  });

  it("starts as Tessera Light and Tessera Dark, and every theme sets every colour token", () => {
    const tesseraLight = findColorTheme("Tessera Light");
    const tesseraDark = findColorTheme("Tessera Dark");
    for (const [name, value] of Object.entries(tesseraLight?.variables ?? {}))
      expect(light.get(name), name).toBe(value);
    for (const [name, value] of Object.entries(tesseraDark?.variables ?? {})) expect(dark.get(name), name).toBe(value);
    const tokenNames = [...light.keys()].filter((name) => name !== "color-scheme").sort();
    for (const theme of COLOR_THEMES) expect(Object.keys(theme.variables).sort(), theme.name).toEqual(tokenNames);
  });

  it("makes hover and selection visible on the sidebar and the surface in every theme", () => {
    for (const [name, vars] of Object.entries(themes)) {
      for (const base of ["--sidebar-bg", "--surface"]) {
        const fill = (token: string) => contrastRatio(resolveColor(token, vars), resolveColor(base, vars));
        if (resolveColor(base, vars) !== resolveColor("--surface-2", vars))
          expect(fill("--surface-2"), `${name}: hover on ${base}`).toBeGreaterThanOrEqual(1.04);
        expect(fill("--surface-3"), `${name}: selection on ${base}`).toBeGreaterThanOrEqual(1.1);
      }
    }
  });

  it("uses the same dark values for data-theme and the system setting", () => {
    expect(darkSystem).toEqual(dark);
  });

  for (const [theme, vars] of Object.entries(themes)) {
    describe(`${theme} theme`, () => {
      it.each(pairs.map((pair) => [`${pair.fg} on ${pair.bg} (${pair.use})`, pair] as const))("%s", (_name, pair) => {
        const min = highContrast.has(theme) && pair.min === AA_TEXT && pair.fg === "--text" ? 7 : pair.min;
        expect(ratio(pair, vars)).toBeGreaterThanOrEqual(min);
      });
    });
  }

  if (process.env.TOKENS_REPORT) {
    it("prints the ratio table", () => {
      const rows = pairs.map((pair) => {
        const [l, d] = [
          ratio(pair, themes["Tessera Light"] as Declarations),
          ratio(pair, themes["Tessera Dark"] as Declarations),
        ];
        return `| \`${pair.fg}\` on \`${pair.bg}\` | ${pair.use} | ${pair.min}:1 | ${l.toFixed(2)} | ${d.toFixed(2)} |`;
      });
      console.log(["| Pair | Use | Min | Light | Dark |", "| --- | --- | --- | --- | --- |", ...rows].join("\n"));
    });
  }
});

describe("primary colour override", () => {
  const extremes = ["#ffffff", "#000000", "#ffff00", "#0000ff", "#808080", "#ff0000"];
  it("keeps every pair readable for every theme with every preset and extreme colours", () => {
    const failures: string[] = [];
    for (const theme of COLOR_THEMES) {
      for (const fill of [...ACCENT_PRESETS.map((preset) => preset.fill), ...extremes]) {
        const tinted = withAccent(theme, fill);
        const vars: Declarations = new Map([...root, ...light, ...Object.entries(tinted.variables), ...derived]);
        for (const pair of pairs) {
          const min = theme.highContrast && pair.min === AA_TEXT && pair.fg === "--text" ? 7 : pair.min;
          const value = ratio(pair, vars);
          if (value < min) failures.push(`${theme.name} + ${fill}: ${pair.fg} on ${pair.bg} ${value.toFixed(2)}`);
        }
      }
    }
    expect(failures).toEqual([]);
  });

  it("applies the colour, and ignores empty or invalid values", () => {
    const dark = findColorTheme("Tessera Dark");
    if (!dark) throw new Error("no Tessera Dark");
    expect(withAccent(dark, "")).toBe(dark);
    expect(withAccent(dark, "nope")).toBe(dark);
    const pink = withAccent(dark, "#E6539F");
    expect(pink.accentOverride).toBe("#e6539f");
    expect(pink.variables["--accent"]).toBe("#e6539f");
    expect(pink.variables["--bg"]).toBe(dark.variables["--bg"]);
    expect(pink.spec.accent).toBe(dark.spec.accent);
    expect(withAccent(pink, "")).toBe(pink);
  });
});

describe("theme.css", () => {
  const theme = parseThemeBlock(readSource("theme.css"));
  const tokenNames = new Set([...(themes["Tessera Light"] as Declarations).keys()]);

  it("maps only tokens that exist, and never a name onto itself", () => {
    for (const [name, value] of theme) {
      for (const [, ref] of value.matchAll(/var\((--[\w-]+)\)/g)) {
        expect(ref, `${name} uses ${ref}`).not.toBe(name);
        expect(tokenNames.has(ref as string), `${name} uses ${ref}, which tokens.css does not define`).toBe(true);
      }
    }
  });

  it("gives every colour role a utility", () => {
    const mapped = new Set([...theme.values()]);
    for (const name of ["--bg", "--surface", "--surface-2", "--surface-3", "--border", "--text", "--text-muted"]) {
      expect(mapped.has(`var(${name})`), name).toBe(true);
    }
    for (const status of statusNames) expect(theme.get(`--color-st-${status}`)).toBe(`var(--st-${status})`);
  });
});
