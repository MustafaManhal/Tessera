// The terminal theme catalog: the app themes' own terminal palettes (packages/ui colorThemes), the bundled collection
// (loaded on demand) and the imported themes; plus how `appearance.terminal-theme` resolves to a theme. An empty name
// means "match the app theme".
import { COLOR_THEMES, type ColorTheme, findColorTheme } from "@tessera/ui";
import { makeTheme, type Theme } from "./model";

type Row = [string, string, string, string, string, string[]];

const hex = (value: string) => `#${value}`;

let bundled: Promise<Theme[]> | null = null;

/** The 900-odd bundled schemes (a dynamic import: nothing loads until a scheme from the collection is in use). */
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

/** An app theme's terminal palette as a terminal theme. */
export function terminalOf(theme: ColorTheme): Theme {
  const { background, foreground, cursor, selection, ansi } = theme.terminal;
  return {
    ...makeTheme({ name: theme.name, background, foreground, cursor, selection, ansi }),
    appearance: theme.kind,
  };
}

/** The terminal palettes of every app theme, in the order the app lists them. */
export function appThemeTerminals(): Theme[] {
  return COLOR_THEMES.map(terminalOf);
}

/**
 * The terminal theme `appearance.terminal-theme` names: null for an empty name (match the app theme), else an app
 * theme's palette, an imported theme or a bundled one of that name, or null when nothing has it.
 */
export function resolveTheme(name: string, imported: readonly Theme[], bundledList: readonly Theme[]): Theme | null {
  if (!name.trim()) return null;
  const app = findColorTheme(name);
  if (app) return terminalOf(app);
  return (
    imported.find((theme) => theme.name === name || theme.id === name) ??
    bundledList.find((theme) => theme.name === name) ??
    null
  );
}
