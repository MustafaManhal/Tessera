// Every text and UI token pair the components use, checked against WCAG 2.2 AA in both themes, on the real
// tokens.css. The pairs and their ratios are listed in .ai/research/tokens-contrast.md
// (print the table: TOKENS_REPORT=1 pnpm vitest run packages/ui/tests/contrast.test.ts -t prints --reporter=verbose).
import { describe, expect, it } from "vitest";
import { AA_TEXT, AA_UI, contrastRatio, mixSrgb, parseColor } from "../src/contrast";
import { type Declarations, parseRules, parseThemeBlock, readSource, resolveColor, rule } from "./css";

const rules = parseRules(readSource("tokens.css"));
const root = rule(rules, ":root");
const light = rule(rules, ':root, [data-theme="light"]');
const dark = rule(rules, '[data-theme="dark"]');
const darkSystem = rule(rules, ':root:not([data-theme="light"])', "@media (prefers-color-scheme: dark)");
const derived = rule(rules, ":root, [data-theme]");

const themes: Record<"light" | "dark", Declarations> = {
  light: new Map([...root, ...light, ...derived]),
  dark: new Map([...root, ...light, ...dark, ...derived]),
};

interface Pair {
  fg: string;
  bg: string;
  min: number;
  use: string;
}

const text = (fg: string, bg: string, use: string): Pair => ({ fg, bg, min: AA_TEXT, use });
const ui = (fg: string, bg: string, use: string): Pair => ({ fg, bg, min: AA_UI, use });

const surfaces = ["--bg", "--surface", "--surface-2", "--surface-3"];
const statusNames = ["working", "needs", "done", "error", "off"];

export const pairs: Pair[] = [
  ...surfaces.map((bg) => text("--text", bg, "body text")),
  ...surfaces.map((bg) => text("--text-muted", bg, "secondary text, placeholders, Kbd")),
  ...["--accent", "--accent-hover", "--accent-press"].map((bg) => text("--accent-fg", bg, "primary button")),
  ...["--danger", "--danger-hover", "--danger-press"].map((bg) => text("--danger-fg", bg, "danger button")),
  text("--text", "--border", "secondary button, pressed"),
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

  it("uses the same dark values for data-theme and the system setting", () => {
    expect(darkSystem).toEqual(dark);
  });

  for (const [theme, vars] of Object.entries(themes)) {
    describe(`${theme} theme`, () => {
      it.each(pairs.map((pair) => [`${pair.fg} on ${pair.bg} (${pair.use})`, pair] as const))("%s", (_name, pair) => {
        expect(ratio(pair, vars)).toBeGreaterThanOrEqual(pair.min);
      });
    });
  }

  if (process.env.TOKENS_REPORT) {
    it("prints the ratio table", () => {
      const rows = pairs.map((pair) => {
        const [l, d] = [ratio(pair, themes.light), ratio(pair, themes.dark)];
        return `| \`${pair.fg}\` on \`${pair.bg}\` | ${pair.use} | ${pair.min}:1 | ${l.toFixed(2)} | ${d.toFixed(2)} |`;
      });
      console.log(["| Pair | Use | Min | Light | Dark |", "| --- | --- | --- | --- | --- |", ...rows].join("\n"));
    });
  }
});

describe("theme.css", () => {
  const theme = parseThemeBlock(readSource("theme.css"));
  const tokenNames = new Set([...themes.light.keys()]);

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
