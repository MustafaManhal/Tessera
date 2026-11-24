// The `[keybindings]` table as a TOML snippet (export/import in the shortcut editor). Only what the config format
// allows here: `"action.id" = "Chord"` and `"action.id" = ["Chord", "Chord"]` (an empty list unbinds). Pure.
import { normalizeChord } from "./chord";

export function toToml(overrides: Readonly<Record<string, readonly string[]>>): string {
  const lines = ["[keybindings]"];
  for (const [id, chords] of Object.entries(overrides).sort(([a], [b]) => (a < b ? -1 : 1))) {
    const quoted = chords.map((chord) => JSON.stringify(chord));
    lines.push(`${JSON.stringify(id)} = ${quoted.length === 1 ? quoted[0] : `[${quoted.join(", ")}]`}`);
  }
  return `${lines.join("\n")}\n`;
}

export interface TomlLineError {
  /** 1-based line in the pasted text. */
  line: number;
  text: string;
}

export interface TomlImport {
  entries: Record<string, string[]>;
  errors: TomlLineError[];
}

const LINE = /^\s*(?:"([^"\\]+)"|([A-Za-z0-9_.-]+))\s*=\s*(.+?)\s*(?:#.*)?$/;

/** Reads a snippet; lines that are not `key = value` with readable chords are reported with their line number. */
export function parseTomlSnippet(text: string): TomlImport {
  const entries: Record<string, string[]> = {};
  const errors: TomlLineError[] = [];
  text.split(/\r?\n/).forEach((raw, index) => {
    const line = raw.trim();
    if (line === "" || line.startsWith("#") || line === "[keybindings]") return;
    const match = LINE.exec(line);
    const id = match?.[1] ?? match?.[2];
    const value = match?.[3];
    if (!id || value === undefined) {
      errors.push({ line: index + 1, text: raw });
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(value);
    } catch {
      errors.push({ line: index + 1, text: raw });
      return;
    }
    const list = typeof parsed === "string" ? (parsed === "" ? [] : [parsed]) : Array.isArray(parsed) ? parsed : null;
    const chords = list?.map((item) => (typeof item === "string" ? normalizeChord(item) : null));
    if (!chords || chords.some((chord) => chord === null)) {
      errors.push({ line: index + 1, text: raw });
      return;
    }
    entries[id] = chords as string[];
  });
  return { entries, errors };
}
