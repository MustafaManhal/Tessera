// Importers for colour scheme files (FR-66): iTerm2 `.itermcolors` (plist XML), Ghostty theme files, and Windows
// Terminal JSON schemes (one scheme, a list, or a settings.json with a "schemes" array). Pure; every failure is a
// ThemeParseError with a catalog key, so the picker can say what is wrong with a file.
import { ANSI_NAMES, makeTheme, normalizeHex, type Theme } from "./model";

export type ThemeParseReason =
  | "empty"
  | "unknownFormat"
  | "badXml"
  | "badJson"
  | "missingColour"
  | "badColour"
  | "tooLarge";

export class ThemeParseError extends Error {
  constructor(
    readonly reason: ThemeParseReason,
    /** What was wrong (a key, a colour), for the message. */
    readonly detail = "",
  ) {
    super(`${reason}${detail ? `: ${detail}` : ""}`);
    this.name = "ThemeParseError";
  }
}

export const MAX_THEME_FILE_BYTES = 512 * 1024;

const baseName = (fileName: string) =>
  fileName
    .replace(/^.*[\\/]/, "")
    .replace(/\.[^.]+$/, "")
    .trim() || "Imported theme";

// iTerm2 ------------------------------------------------------------------------------------------------------------

function plistColours(xml: string): Map<string, [number, number, number]> {
  const colours = new Map<string, [number, number, number]>();
  const entry = /<key>([^<]+)<\/key>\s*<dict>([\s\S]*?)<\/dict>/g;
  for (let match = entry.exec(xml); match; match = entry.exec(xml)) {
    const name = match[1] ?? "";
    const body = match[2] ?? "";
    const part = (component: string) => {
      const found = new RegExp(
        `<key>${component} Component</key>\\s*<(?:real|integer)>\\s*([^<\\s]+)\\s*</(?:real|integer)>`,
      ).exec(body);
      const value = found?.[1] === undefined ? Number.NaN : Number(found[1]);
      return value;
    };
    const [r, g, b] = [part("Red"), part("Green"), part("Blue")];
    if ([r, g, b].some((v) => !Number.isFinite(v))) {
      if (/^(Ansi \d+|Background|Foreground|Cursor|Selection) Color$/.test(name))
        throw new ThemeParseError("badColour", name);
      continue;
    }
    colours.set(name, [r as number, g as number, b as number]);
  }
  return colours;
}

const toHex = ([r, g, b]: [number, number, number]) =>
  `#${[r, g, b]
    .map((v) =>
      Math.round(Math.min(1, Math.max(0, v)) * 255)
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;

export function parseItermColors(text: string, fileName = "Imported theme"): Theme {
  if (!/<plist[\s>]/.test(text) || !/<\/plist>/.test(text)) throw new ThemeParseError("badXml");
  const colours = plistColours(text);
  const need = (key: string) => {
    const colour = colours.get(key);
    if (!colour) throw new ThemeParseError("missingColour", key);
    return toHex(colour);
  };
  const ansi = Array.from({ length: 16 }, (_, index) => need(`Ansi ${index} Color`));
  const cursor = colours.get("Cursor Color");
  const selection = colours.get("Selection Color");
  return makeTheme({
    name: baseName(fileName),
    background: need("Background Color"),
    foreground: need("Foreground Color"),
    cursor: cursor ? toHex(cursor) : null,
    selection: selection ? toHex(selection) : null,
    ansi,
    imported: true,
  });
}

// Ghostty -----------------------------------------------------------------------------------------------------------

export function parseGhostty(text: string, fileName = "Imported theme"): Theme {
  const ansi: (string | null)[] = Array(16).fill(null);
  const values: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    if (key === "palette") {
      const match = /^(\d+)\s*=\s*(\S+)$/.exec(value);
      if (!match) throw new ThemeParseError("badColour", `palette = ${value}`);
      const index = Number(match[1]);
      const hex = normalizeHex(match[2]);
      if (!hex) throw new ThemeParseError("badColour", `palette ${index}`);
      if (index >= 0 && index < 16) ansi[index] = hex;
    } else values[key] = value;
  }
  const pick = (key: string, required: boolean) => {
    const value = values[key];
    if (value === undefined) {
      if (required) throw new ThemeParseError("missingColour", key);
      return null;
    }
    const hex = normalizeHex(value);
    if (!hex) throw new ThemeParseError("badColour", key);
    return hex;
  };
  const missing = ansi.indexOf(null);
  if (missing >= 0) throw new ThemeParseError("missingColour", `palette ${missing}`);
  return makeTheme({
    name: baseName(fileName),
    background: pick("background", true) as string,
    foreground: pick("foreground", true) as string,
    cursor: pick("cursor-color", false),
    selection: pick("selection-background", false),
    ansi: ansi as string[],
    imported: true,
  });
}

// Windows Terminal ---------------------------------------------------------------------------------------------------

const WT_ANSI = [...ANSI_NAMES, ...ANSI_NAMES.map((name) => `bright${name[0]?.toUpperCase()}${name.slice(1)}`)];
/** Windows Terminal says "purple" where others say "magenta": either spelling is read. */
const wtKey = (key: string) => key.replace("magenta", "purple").replace("Magenta", "Purple");
const wtAlt = (key: string) => key.replace("purple", "magenta").replace("Purple", "Magenta");

function schemeFrom(value: unknown, fileName: string): Theme {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new ThemeParseError("unknownFormat");
  const record = value as Record<string, unknown>;
  const need = (key: string) => {
    const raw = record[key] ?? record[wtAlt(key)];
    if (raw === undefined) throw new ThemeParseError("missingColour", key);
    const hex = normalizeHex(raw);
    if (!hex) throw new ThemeParseError("badColour", key);
    return hex;
  };
  const optional = (key: string) => (record[key] === undefined ? null : need(key));
  const name = typeof record.name === "string" && record.name.trim() !== "" ? record.name.trim() : baseName(fileName);
  return makeTheme({
    name,
    background: need("background"),
    foreground: need("foreground"),
    cursor: optional("cursorColor"),
    selection: optional("selectionBackground"),
    ansi: WT_ANSI.map((key) => need(wtKey(key))),
    imported: true,
  });
}

/** One scheme, or every scheme of a list or of a settings.json. */
export function parseWindowsTerminal(text: string, fileName = "Imported theme"): Theme[] {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new ThemeParseError("badJson");
  }
  const list = Array.isArray(json)
    ? json
    : typeof json === "object" && json !== null && Array.isArray((json as { schemes?: unknown }).schemes)
      ? (json as { schemes: unknown[] }).schemes
      : [json];
  if (list.length === 0) throw new ThemeParseError("unknownFormat");
  return list.map((entry) => schemeFrom(entry, fileName));
}

// Any ----------------------------------------------------------------------------------------------------------------

export type ThemeFormat = "iterm" | "windowsTerminal" | "ghostty";

export function detectFormat(text: string): ThemeFormat | null {
  const head = text.trimStart().slice(0, 200);
  if (head.startsWith("<?xml") || head.startsWith("<plist") || /<plist[\s>]/.test(head)) return "iterm";
  if (head.startsWith("{") || head.startsWith("[")) return "windowsTerminal";
  if (/^\s*(#.*\n\s*)*[a-z-]+\s*=/.test(text.slice(0, 2000))) return "ghostty";
  return null;
}

/** Reads a theme file of any supported format. Throws ThemeParseError. */
export function parseThemeFile(text: string, fileName: string): Theme[] {
  if (text.trim() === "") throw new ThemeParseError("empty");
  if (text.length > MAX_THEME_FILE_BYTES) throw new ThemeParseError("tooLarge");
  switch (detectFormat(text)) {
    case "iterm":
      return [parseItermColors(text, fileName)];
    case "windowsTerminal":
      return parseWindowsTerminal(text, fileName);
    case "ghostty":
      return [parseGhostty(text, fileName)];
    default:
      throw new ThemeParseError("unknownFormat");
  }
}
