// The theme model (M4.5, FR-66): one colour scheme as the picker, the importers and the terminal share it, its mapping
// to the terminal engine's theme, and the contrast checks that warn about a scheme nobody can read.
import type { EngineTheme } from "@tessera/term";
import { contrastRatio, parseColor } from "@tessera/ui";

export type Appearance = "light" | "dark";

export interface Theme {
  /** Stable id: the name for bundled themes, `imported:<name>` for imported ones. */
  id: string;
  name: string;
  appearance: Appearance;
  background: string;
  foreground: string;
  cursor: string;
  selection: string;
  /** The 16 ANSI colours: black, red, green, yellow, blue, magenta, cyan, white, then the bright ones. */
  ansi: string[];
  /** Imported by the user (shown with a marker, can be removed). */
  imported?: boolean;
}

export const ANSI_NAMES = ["black", "red", "green", "yellow", "blue", "magenta", "cyan", "white"] as const;

/** "#rrggbb" for 6 hex digits with or without "#"; null when it is not a colour. */
export function normalizeHex(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = /^\s*#?([0-9a-f]{6})\s*$/i.exec(value);
  if (match?.[1]) return `#${match[1].toLowerCase()}`;
  const short = /^\s*#?([0-9a-f]{3})\s*$/i.exec(value);
  if (short?.[1])
    return `#${[...short[1]]
      .map((c) => c + c)
      .join("")
      .toLowerCase()}`;
  return null;
}

function rgb(hex: string): [number, number, number] {
  return [
    Number.parseInt(hex.slice(1, 3), 16),
    Number.parseInt(hex.slice(3, 5), 16),
    Number.parseInt(hex.slice(5, 7), 16),
  ];
}

/** WCAG contrast of two "#rrggbb" colours. */
export function contrastOf(a: string, b: string): number {
  const left = parseColor(a);
  const right = parseColor(b);
  if (!left || !right) return 1;
  return contrastRatio(left, right);
}

/** Light when the background is brighter than mid grey (perceived luminance). */
export function appearanceOf(background: string): Appearance {
  const [r, g, b] = rgb(background);
  return 0.299 * r + 0.587 * g + 0.114 * b > 127 ? "light" : "dark";
}

export const MIN_TEXT_CONTRAST = 4.5;
export const MIN_ANSI_CONTRAST = 3;
/** "High contrast" in the picker: text on background at least AAA. */
export const HIGH_CONTRAST = 7;

export type ThemeIssue = { kind: "foreground"; ratio: number } | { kind: "ansi"; index: number; ratio: number };

/**
 * Warnings for a scheme: the foreground under 4.5:1 on the background, or an ANSI colour under 3:1 (an error message or
 * a prompt nobody can see). Black and white (0, 7, 8, 15) are skipped: they are often meant to match a background.
 */
export function themeIssues(theme: Pick<Theme, "background" | "foreground" | "ansi">): ThemeIssue[] {
  const issues: ThemeIssue[] = [];
  const text = contrastOf(theme.foreground, theme.background);
  if (text < MIN_TEXT_CONTRAST) issues.push({ kind: "foreground", ratio: text });
  theme.ansi.forEach((colour, index) => {
    if (index === 0 || index === 7 || index === 8 || index === 15) return;
    const ratio = contrastOf(colour, theme.background);
    if (ratio < MIN_ANSI_CONTRAST) issues.push({ kind: "ansi", index, ratio });
  });
  return issues;
}

export function isHighContrast(theme: Pick<Theme, "background" | "foreground">): boolean {
  return contrastOf(theme.foreground, theme.background) >= HIGH_CONTRAST;
}

/** The terminal engine's theme for a scheme. The cursor text is the background. */
export function toEngineTheme(theme: Theme): EngineTheme {
  const [
    black,
    red,
    green,
    yellow,
    blue,
    magenta,
    cyan,
    white,
    brightBlack,
    brightRed,
    brightGreen,
    brightYellow,
    brightBlue,
    brightMagenta,
    brightCyan,
    brightWhite,
  ] = theme.ansi as [
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
  ];
  return {
    background: theme.background,
    foreground: theme.foreground,
    cursor: theme.cursor,
    cursorAccent: theme.background,
    selectionBackground: theme.selection,
    black,
    red,
    green,
    yellow,
    blue,
    magenta,
    cyan,
    white,
    brightBlack,
    brightRed,
    brightGreen,
    brightYellow,
    brightBlue,
    brightMagenta,
    brightCyan,
    brightWhite,
  };
}

export function makeTheme(input: {
  name: string;
  background: string;
  foreground: string;
  cursor?: string | null;
  selection?: string | null;
  ansi: string[];
  imported?: boolean;
}): Theme {
  return {
    id: input.imported ? `imported:${input.name}` : input.name,
    name: input.name,
    appearance: appearanceOf(input.background),
    background: input.background,
    foreground: input.foreground,
    cursor: input.cursor ?? input.foreground,
    selection: input.selection ?? input.foreground,
    ansi: input.ansi,
    ...(input.imported ? { imported: true } : {}),
  };
}

/** The chrome next to the terminal blends with the theme: the background becomes `--term-bg`. */
export function chromeVariables(theme: Theme | null): Record<string, string> {
  return theme ? { "--term-bg": theme.background } : {};
}
