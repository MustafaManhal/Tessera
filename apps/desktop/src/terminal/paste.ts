// Paste and drop rules (FR-07, FR-12), pure and unit-tested.
// - A paste with a line break or a control character asks first: one stray newline runs a command, and escape
//   sequences can end a bracketed paste early and type anything. (Ghostty treats bracketed pastes as safe by default;
//   we ask anyway, since the program may not handle a pasted newline the way the user expects.)
// - Bracketed paste itself is xterm's job: `engine.paste` wraps the text when the program turned mode 2004 on.
// - Dropped files insert their paths, shell-quoted, space-separated (POSIX shells; PowerShell on Windows).
import type { Platform } from "@tessera/ui";

/** C0 controls except tab, newline and carriage return; DEL; C1 controls (ESC, 0x1b, is in C0). */
function isControl(code: number): boolean {
  if (code === 0x09 || code === 0x0a || code === 0x0d) return false;
  return code < 0x20 || (code >= 0x7f && code <= 0x9f);
}

function mapControls(text: string, replace: (char: string, code: number) => string): string {
  let out = "";
  for (const char of text) {
    const code = char.charCodeAt(0);
    out += isControl(code) ? replace(char, code) : char;
  }
  return out;
}

export function hasLineBreak(text: string): boolean {
  return /[\r\n]/.test(text);
}

export function hasControlCharacters(text: string): boolean {
  for (const char of text) if (isControl(char.charCodeAt(0))) return true;
  return false;
}

export function pasteNeedsConfirm(text: string): boolean {
  return hasLineBreak(text) || hasControlCharacters(text);
}

/** "Paste as plain text": control characters removed (line breaks kept). */
export function stripControlCharacters(text: string): string {
  return mapControls(text, () => "");
}

/** "Paste as one line": line breaks become single spaces, control characters go, ends trimmed. */
export function asOneLine(text: string): string {
  return stripControlCharacters(text)
    .split(/\r\n|\r|\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .join(" ");
}

/** The first lines for the confirmation, with control characters shown as visible symbols (␛ for ESC). */
export function previewLines(text: string, max = 6): { lines: string[]; more: number } {
  const all = text.replace(/\r\n|\r/g, "\n").split("\n");
  if (all.length > 1 && all.at(-1) === "") all.pop();
  const visible = (line: string) =>
    mapControls(line, (_char, code) => (code < 0x20 ? String.fromCharCode(0x2400 + code) : code === 0x7f ? "␡" : "�"));
  return { lines: all.slice(0, max).map(visible), more: Math.max(0, all.length - max) };
}

export function lineCount(text: string): number {
  const lines = text.replace(/\r\n|\r/g, "\n").split("\n");
  return lines.at(-1) === "" ? lines.length - 1 : lines.length;
}

/** POSIX shells: plain when safe, else single quotes with ' written as '\''. */
export function quotePosix(path: string): string {
  if (path !== "" && /^[A-Za-z0-9_@%+=:,./-]+$/.test(path)) return path;
  return `'${path.replaceAll("'", `'\\''`)}'`;
}

/** PowerShell: plain when safe, else single quotes with ' doubled. */
export function quotePowerShell(path: string): string {
  if (path !== "" && /^[A-Za-z0-9_\-.:\\/]+$/.test(path)) return path;
  return `'${path.replaceAll("'", "''").replaceAll("‘", "‘‘").replaceAll("’", "’’")}'`;
}

/** Dropped paths as typed text: quoted for the platform's shell, space-separated, with a trailing space. */
export function quotePaths(paths: readonly string[], platform: Platform): string {
  const quote = platform === "windows" ? quotePowerShell : quotePosix;
  return paths.length === 0 ? "" : `${paths.map(quote).join(" ")} `;
}

/** Copy with trailing whitespace trimmed from every line (and trailing blank lines dropped). */
export function trimTrailingWhitespace(text: string): string {
  return text
    .split("\n")
    .map((line) => line.replace(/[ \t ]+$/, ""))
    .join("\n")
    .replace(/\n+$/, "");
}
