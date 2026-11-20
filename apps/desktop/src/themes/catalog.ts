// The theme catalog: the two built-in palettes (from the design tokens), the bundled collection (loaded on demand), and
// the imported themes; plus how a theme name from the config resolves to a theme.
import { DEFAULT_THEMES } from "@tessera/term";
import { type Appearance, makeTheme, type Theme } from "./model";

type Row = [string, string, string, string, string, string[]];

const hex = (value: string) => `#${value}`;

let bundled: Promise<Theme[]> | null = null;

/** The 900-odd bundled schemes (a dynamic import: nothing loads until a non-default theme is in use). */
export function loadBundledThemes(): Promise<Theme[]> {
  bundled ??= import("./iterm2-schemes.json").then((module) =>
    (module.default as Row[]).map(([name, background, foreground, cursor, selection, ansi]) =>
      makeTheme({
        name,
        background: hex(background),
        foreground: hex(foreground),
        cursor: hex(cursor),
        selection: hex(selection),
        ansi: ansi.map(hex),
      }),
    ),
  );
  return bundled;
}

/** The theme names the config uses by default. "Tessera Night" and "GitHub Light" (the schema's defaults) mean the built-in palettes. */
export const BUILTIN_NAMES: Record<Appearance, string> = { dark: "Tessera Night", light: "Tessera Light" };
const BUILTIN_ALIASES: Record<string, Appearance> = {
  "Tessera Night": "dark",
  "Tessera Light": "light",
  "GitHub Light": "light",
};

export function isBuiltinName(name: string): boolean {
  return name in BUILTIN_ALIASES;
}

function fromEngine(name: string, appearance: Appearance): Theme {
  const base = DEFAULT_THEMES[appearance];
  return makeTheme({
    name,
    background: base.background,
    foreground: base.foreground,
    cursor: base.cursor,
    selection: appearance === "light" ? "#c9c9f2" : "#3a3d52",
    ansi: [
      base.black,
      base.red,
      base.green,
      base.yellow,
      base.blue,
      base.magenta,
      base.cyan,
      base.white,
      base.brightBlack,
      base.brightRed,
      base.brightGreen,
      base.brightYellow,
      base.brightBlue,
      base.brightMagenta,
      base.brightCyan,
      base.brightWhite,
    ],
  });
}

/** The built-in palettes as themes (for the picker; the terminal uses the live design tokens for them). */
export function builtinThemes(): Theme[] {
  return [fromEngine(BUILTIN_NAMES.dark, "dark"), fromEngine(BUILTIN_NAMES.light, "light")];
}

/**
 * The theme a config name stands for: null for the built-in palettes (the caller uses the design tokens), the imported
 * or bundled theme of that name, or null when nothing has the name (an unknown name falls back to the built-in).
 */
export function resolveTheme(name: string, imported: readonly Theme[], bundledList: readonly Theme[]): Theme | null {
  if (isBuiltinName(name)) return null;
  return (
    imported.find((theme) => theme.name === name || theme.id === name) ??
    bundledList.find((theme) => theme.name === name) ??
    null
  );
}
