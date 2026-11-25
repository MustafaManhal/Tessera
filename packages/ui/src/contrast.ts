// WCAG 2.2 contrast maths for token checks (tests/contrast.test.ts) and, later, user terminal themes.
// https://www.w3.org/TR/WCAG22/#dfn-contrast-ratio and #dfn-relative-luminance

/** sRGB channels 0–255 and alpha 0–1. */
export type Rgba = readonly [r: number, g: number, b: number, a: number];

/** WCAG AA minimums: normal text, and UI parts and graphics (1.4.3, 1.4.11). */
export const AA_TEXT = 4.5;
export const AA_UI = 3;

/** Parses `#rgb`, `#rrggbb`, `#rrggbbaa`, `rgb(r g b / a)`, `rgb(r, g, b)` and `transparent`. */
export function parseColor(value: string): Rgba {
  const v = value.trim().toLowerCase();
  if (v === "transparent") return [0, 0, 0, 0];
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/.exec(v)?.[1];
  if (hex) {
    const full = hex.length === 3 ? [...hex].map((c) => c + c).join("") : hex;
    const channel = (i: number) => Number.parseInt(full.slice(i, i + 2), 16);
    return [channel(0), channel(2), channel(4), full.length === 8 ? channel(6) / 255 : 1];
  }
  const rgb = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)\s*(?:[/,]\s*([\d.]+)(%?))?\s*\)$/.exec(v);
  if (rgb) {
    const [, r, g, b, a, percent] = rgb;
    const alpha = a === undefined ? 1 : Number(a) / (percent ? 100 : 1);
    return [Number(r), Number(g), Number(b), alpha];
  }
  throw new Error(`contrast: cannot parse colour "${value}"`);
}

/** CSS `color-mix(in srgb, a weight, b)`, weight 0–1 for `a`. Mixes premultiplied, as CSS does. */
export function mixSrgb(a: Rgba, b: Rgba, weight: number): Rgba {
  const alpha = a[3] * weight + b[3] * (1 - weight);
  if (alpha === 0) return [0, 0, 0, 0];
  const channel = (i: 0 | 1 | 2) => (a[i] * a[3] * weight + b[i] * b[3] * (1 - weight)) / alpha;
  return [channel(0), channel(1), channel(2), alpha];
}

/** Paints `top` over an opaque `bottom` (source-over). */
export function composite(top: Rgba, bottom: Rgba): Rgba {
  const a = top[3];
  const channel = (i: 0 | 1 | 2) => top[i] * a + bottom[i] * (1 - a);
  return [channel(0), channel(1), channel(2), 1];
}

/** WCAG relative luminance of an opaque colour. */
export function relativeLuminance([r, g, b]: Rgba): number {
  const linear = (c: number) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

/** Contrast ratio 1–21 of `fg` on `bg`. A translucent `fg` is painted over `bg` first; `bg` must be opaque. */
export function contrastRatio(fg: Rgba | string, bg: Rgba | string): number {
  const back = typeof bg === "string" ? parseColor(bg) : bg;
  if (back[3] < 1) throw new Error("contrast: the background must be opaque");
  const front = composite(typeof fg === "string" ? parseColor(fg) : fg, back);
  const [hi, lo] = [relativeLuminance(front), relativeLuminance(back)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}
