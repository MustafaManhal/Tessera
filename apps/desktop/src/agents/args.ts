// The extra-arguments field: one line of shell-like words becomes the argv list the backend stores. Quotes group
// spaces, a backslash escapes the next character, and an unterminated quote is an error the form shows instead of
// guessing. The environment field uses the same name rule as Rust (brief 24).

export type ArgsError = "unterminated" | "trailingEscape";

export interface ParsedArgs {
  args: string[];
  error: ArgsError | null;
}

/** Splits `text` like a POSIX shell would for simple words (no variables, globs or command substitution). */
export function parseArgs(text: string): ParsedArgs {
  const args: string[] = [];
  let current = "";
  let started = false;
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < text.length; i++) {
    const char = text[i] as string;
    if (quote === "'") {
      if (char === "'") quote = null;
      else current += char;
      continue;
    }
    if (quote === '"') {
      if (char === '"') {
        quote = null;
      } else if (char === "\\" && (text[i + 1] === '"' || text[i + 1] === "\\")) {
        current += text[i + 1] as string;
        i++;
      } else {
        current += char;
      }
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      started = true;
      continue;
    }
    if (char === "\\") {
      if (i + 1 >= text.length) return { args, error: "trailingEscape" };
      current += text[i + 1] as string;
      i++;
      started = true;
      continue;
    }
    if (char === " " || char === "\t" || char === "\n" || char === "\r") {
      if (started) {
        args.push(current);
        current = "";
        started = false;
      }
      continue;
    }
    current += char;
    started = true;
  }
  if (quote) return { args, error: "unterminated" };
  if (started) args.push(current);
  return { args, error: null };
}

/** The inverse, for editing and duplicating: words that need it get single quotes (and `'` becomes `'\''`). */
export function joinArgs(args: readonly string[]): string {
  return args
    .map((arg) => (arg !== "" && /^[A-Za-z0-9_@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", "'\\''")}'`))
    .join(" ");
}

/** Rust validates env names with the same pattern (`agent.profile_invalid` otherwise). */
export const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function isValidEnvKey(key: string): boolean {
  return ENV_KEY.test(key);
}
