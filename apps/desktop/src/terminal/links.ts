// Clickable things in terminal output (FR-06), pure and unit-tested:
// - URLs and OSC 8 hyperlinks open only with an allowed scheme (http, https, mailto). `javascript:`, `file:`, `data:`
//   and anything else never open, even from an OSC 8 link a program printed.
// - `path:line[:col]` (compiler and grep output) resolves against the pane's cwd and goes to the editor action.

export const ALLOWED_SCHEMES = new Set(["http:", "https:", "mailto:"]);

/** The URL to open, or null when the scheme is not allowed or the text is not a URL. */
export function safeUrl(text: string): string | null {
  try {
    const url = new URL(text.trim());
    return ALLOWED_SCHEMES.has(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

export interface PathLink {
  path: string;
  line: number;
  column?: number;
}

// A path with a file extension, then :line and an optional :column. It may start with ./ ../ ~/ / or a drive letter.
const PATH_LINK =
  /(?<![\w./\\:@-])((?:\.{1,2}[\\/]|~[\\/]|[\\/]|[A-Za-z]:[\\/])?(?:[\w.@-]+[\\/])*[\w@-][\w.@-]*\.[A-Za-z0-9]{1,10}):(\d{1,7})(?::(\d{1,5}))?(?!\w|:\d)/g;
const URL_IN_TEXT = /\b[a-z][a-z0-9+.-]*:\/\/\S+/gi;

/** `path:line[:col]` matches in one line of terminal text, skipping anything inside a URL. */
export function findPathLinks(line: string): { start: number; end: number; text: string }[] {
  const urls = Array.from(line.matchAll(URL_IN_TEXT), (m) => [m.index ?? 0, (m.index ?? 0) + m[0].length] as const);
  const out: { start: number; end: number; text: string }[] = [];
  for (const match of line.matchAll(PATH_LINK)) {
    const start = match.index ?? 0;
    const end = start + match[0].length;
    if (urls.some(([a, b]) => start < b && end > a)) continue;
    out.push({ start, end, text: match[0] });
  }
  return out;
}

/** Splits `src/main.rs:42:7` into path, line and column. */
export function parsePathLink(text: string): PathLink | null {
  const match = /^(.*?):(\d+)(?::(\d+))?$/.exec(text.trim());
  if (!match?.[1] || !match[2]) return null;
  const line = Number(match[2]);
  if (line < 1) return null;
  const column = match[3] ? Number(match[3]) : undefined;
  return column === undefined ? { path: match[1], line } : { path: match[1], line, column };
}

/** Resolves a path against a cwd: absolute paths stay, `~/` stays for the opener, the rest joins the cwd. */
export function resolvePath(path: string, cwd: string): string {
  if (path.startsWith("\\\\")) return path.replaceAll("/", "\\");
  if (path.startsWith("/") || path.startsWith("~") || /^[A-Za-z]:[\\/]/.test(path)) return path;

  if (/^[A-Za-z]:[\\/]/.test(cwd)) {
    const [, drive, rest] = /^([A-Za-z]:)[\\/](.*)$/.exec(cwd) ?? [];
    if (!drive) return path;
    const parts = rest ? rest.split(/[\\/]+/).filter(Boolean) : [];
    for (const piece of path.split(/[\\/]+/)) {
      if (piece === "" || piece === ".") continue;
      if (piece === "..") parts.pop();
      else parts.push(piece);
    }
    return `${drive}\\${parts.join("\\")}`;
  }

  if (cwd.startsWith("\\\\")) {
    const parts = cwd
      .slice(2)
      .split(/[\\/]+/)
      .filter(Boolean);
    for (const piece of path.split(/[\\/]+/)) {
      if (piece === "" || piece === ".") continue;
      if (piece === "..") {
        if (parts.length > 2) parts.pop();
      } else parts.push(piece);
    }
    return `\\\\${parts.join("\\")}`;
  }

  const separator = "/";
  const parts = cwd.split(/[\\/]+/).filter((part, i) => part !== "" || i === 0);
  for (const piece of path.split(/[\\/]+/)) {
    if (piece === "." || piece === "") continue;
    if (piece === "..") {
      if (parts.length > 1) parts.pop();
    } else parts.push(piece);
  }
  const joined = parts.join(separator);
  return joined.startsWith("/") ? joined : `/${joined}`;
}

/** Whether the click asked to open: Cmd on macOS, Ctrl elsewhere (FR-06). */
export function wantsOpen(
  event: { metaKey: boolean; ctrlKey: boolean },
  platform: "mac" | "windows" | "other",
): boolean {
  return platform === "mac" ? event.metaKey : event.ctrlKey;
}
