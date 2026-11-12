// Pure mapping from our engine options to xterm.js options, and the default terminal themes. Kept free of DOM and
// xterm imports so it is unit-tested in Node.
import type { CursorStyle, EngineOptions, EngineTheme } from "./types";

/** Tessera's default terminal palettes (UI-UX §2: the terminal uses its own theme; the chrome blends with it). */
export const DEFAULT_THEMES: Record<"light" | "dark", EngineTheme> = {
  light: {
    background: "#f6f6f7",
    foreground: "#15171a",
    cursor: "#15171a",
    cursorAccent: "#f6f6f7",
    selectionBackground: "rgba(91, 91, 214, 0.25)",
    black: "#15171a",
    red: "#c4262c",
    green: "#1b7a43",
    yellow: "#8a5a00",
    blue: "#2156c2",
    magenta: "#8b3fd9",
    cyan: "#0e7490",
    white: "#5d626b",
    brightBlack: "#7c818a",
    brightRed: "#d13438",
    brightGreen: "#1e8e4e",
    brightYellow: "#a16207",
    brightBlue: "#2f7cf6",
    brightMagenta: "#a855f7",
    brightCyan: "#0891b2",
    brightWhite: "#15171a",
  },
  dark: {
    background: "#0f1012",
    foreground: "#e8e9ec",
    cursor: "#e8e9ec",
    cursorAccent: "#0f1012",
    selectionBackground: "rgba(139, 141, 255, 0.3)",
    black: "#1e2024",
    red: "#ff6369",
    green: "#3dd68c",
    yellow: "#ffb224",
    blue: "#5b9bff",
    magenta: "#b98aff",
    cyan: "#4cc9e0",
    white: "#c8cbd1",
    brightBlack: "#70757e",
    brightRed: "#ff8a8f",
    brightGreen: "#6ee7a8",
    brightYellow: "#ffd166",
    brightBlue: "#8bb8ff",
    brightMagenta: "#d0b0ff",
    brightCyan: "#7fdcef",
    brightWhite: "#ffffff",
  },
};

export const FONT_SIZE = { min: 8, max: 40 } as const;

export function clampFontSize(size: number): number {
  if (!Number.isFinite(size)) return 13;
  return Math.min(FONT_SIZE.max, Math.max(FONT_SIZE.min, Math.round(size)));
}

/** The xterm.js options for ours (the subset xterm understands; renderer and ligatures are addons). */
export interface XtermOptionSubset {
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
  fontWeight: number;
  fontWeightBold: number;
  cursorStyle: CursorStyle;
  cursorBlink: boolean;
  cursorInactiveStyle: "outline";
  scrollback: number;
  macOptionIsMeta: boolean;
  screenReaderMode: boolean;
  theme: EngineTheme;
}

export function toXtermOptions(options: Partial<EngineOptions>): Partial<XtermOptionSubset> {
  const out: Partial<XtermOptionSubset> = {};
  if (options.fontFamily !== undefined) out.fontFamily = options.fontFamily;
  if (options.fontSize !== undefined) out.fontSize = clampFontSize(options.fontSize);
  if (options.lineHeight !== undefined) out.lineHeight = Math.min(2, Math.max(1, options.lineHeight));
  if (options.fontWeight !== undefined) out.fontWeight = options.fontWeight;
  if (options.fontWeightBold !== undefined) out.fontWeightBold = options.fontWeightBold;
  if (options.cursorStyle !== undefined) {
    out.cursorStyle = options.cursorStyle;
    // The unfocused cursor is hollow, like the placeholder's (and most terminals').
    out.cursorInactiveStyle = "outline";
  }
  if (options.cursorBlink !== undefined) out.cursorBlink = options.cursorBlink;
  if (options.scrollback !== undefined)
    out.scrollback = Math.max(0, Math.min(1_000_000, Math.round(options.scrollback)));
  if (options.macOptionIsMeta !== undefined) out.macOptionIsMeta = options.macOptionIsMeta;
  if (options.screenReaderMode !== undefined) out.screenReaderMode = options.screenReaderMode;
  if (options.theme !== undefined) out.theme = options.theme;
  return out;
}

/** Ligatures need `font-feature-settings` on the glyph atlas; "calt" is what JetBrains Mono's ligatures use. */
export const LIGATURE_FEATURES = '"calt" on, "liga" on';
