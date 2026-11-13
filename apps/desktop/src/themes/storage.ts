// App-local persistence for themes (until the Rust side has a themes folder, `themes_list` / `theme_import`): imported
// schemes and favourites in localStorage. Every access is guarded: blocked storage means "nothing saved", never an error.
import { makeTheme, normalizeHex, type Theme } from "./model";

const IMPORTED_KEY = "tessera.importedThemes";
const FAVOURITES_KEY = "tessera.favouriteThemes";

function read(key: string): unknown {
  try {
    return JSON.parse(localStorage.getItem(key) ?? "null");
  } catch {
    return null;
  }
}

function write(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Quota or blocked storage: the change lasts for this session.
  }
}

/** Imported themes, re-validated on the way in (a hand-edited or old entry that is not a theme is dropped). */
export function loadImported(): Theme[] {
  const raw = read(IMPORTED_KEY);
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry): Theme[] => {
    if (typeof entry !== "object" || entry === null) return [];
    const record = entry as Record<string, unknown>;
    const ansi = Array.isArray(record.ansi) ? record.ansi.map(normalizeHex) : [];
    const background = normalizeHex(record.background);
    const foreground = normalizeHex(record.foreground);
    if (
      typeof record.name !== "string" ||
      !background ||
      !foreground ||
      ansi.length !== 16 ||
      ansi.some((c) => c === null)
    )
      return [];
    return [
      makeTheme({
        name: record.name,
        background,
        foreground,
        cursor: normalizeHex(record.cursor),
        selection: normalizeHex(record.selection),
        ansi: ansi as string[],
        imported: true,
      }),
    ];
  });
}

export const saveImported = (themes: readonly Theme[]) => write(IMPORTED_KEY, themes);

export function loadFavourites(): string[] {
  const raw = read(FAVOURITES_KEY);
  return Array.isArray(raw) ? raw.filter((entry): entry is string => typeof entry === "string") : [];
}

export const saveFavourites = (ids: readonly string[]) => write(FAVOURITES_KEY, ids);
