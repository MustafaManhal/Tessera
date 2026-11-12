// Test helper: reads tokens.css and theme.css and resolves token values to colours, so the contrast test checks the
// real stylesheet and not a copy of its values.
import { readFileSync } from "node:fs";
import { mixSrgb, parseColor, type Rgba } from "../src/contrast";

export type Declarations = Map<string, string>;

export interface CssRule {
  selector: string;
  media?: string;
  declarations: Declarations;
}

export function readSource(name: "tokens.css" | "theme.css"): string {
  return readFileSync(new URL(`../src/${name}`, import.meta.url), "utf8");
}

function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

/** Index just past the "}" matching the "{" at `open`. */
function blockEnd(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}" && --depth === 0) return i + 1;
  }
  throw new Error("css: unbalanced braces");
}

/** Custom properties (`--name: value;`) of a block body; nested blocks are skipped. */
export function parseDeclarations(body: string): Declarations {
  let flat = body;
  for (let open = flat.indexOf("{"); open !== -1; open = flat.indexOf("{")) {
    const start = flat.lastIndexOf(";", open) + 1;
    flat = flat.slice(0, start) + flat.slice(blockEnd(flat, open));
  }
  const declarations: Declarations = new Map();
  for (const part of flat.split(";")) {
    const colon = part.indexOf(":");
    const name = part.slice(0, colon).trim();
    if (colon === -1 || !name.startsWith("--")) continue;
    declarations.set(
      name,
      part
        .slice(colon + 1)
        .trim()
        .replace(/\s+/g, " "),
    );
  }
  return declarations;
}

/** Style rules at the top level and inside @media; other at-rules are skipped. */
export function parseRules(css: string): CssRule[] {
  const rules: CssRule[] = [];
  const walk = (text: string, media?: string) => {
    let i = 0;
    for (let open = text.indexOf("{", i); open !== -1; open = text.indexOf("{", i)) {
      const prelude = text.slice(i, open).trim().replace(/\s+/g, " ");
      const end = blockEnd(text, open);
      const body = text.slice(open + 1, end - 1);
      if (prelude.startsWith("@media")) walk(body, prelude);
      else if (!prelude.startsWith("@"))
        rules.push({ selector: prelude, media, declarations: parseDeclarations(body) });
      i = end;
    }
  };
  walk(stripComments(css));
  return rules;
}

/** The declarations of `@theme inline { … }` in theme.css. */
export function parseThemeBlock(css: string): Declarations {
  const text = stripComments(css);
  const open = text.indexOf("{", text.indexOf("@theme inline"));
  return parseDeclarations(text.slice(open + 1, blockEnd(text, open) - 1));
}

export function rule(rules: CssRule[], selector: string, media?: string): Declarations {
  const found = rules.find((r) => r.selector === selector && r.media === media);
  if (!found) throw new Error(`css: no rule "${selector}"${media ? ` in ${media}` : ""}`);
  return found.declarations;
}

/** Splits on commas outside parentheses. */
function splitArgs(text: string): string[] {
  const args: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "(") depth++;
    else if (text[i] === ")") depth--;
    else if (text[i] === "," && depth === 0) {
      args.push(text.slice(start, i).trim());
      start = i + 1;
    }
  }
  args.push(text.slice(start).trim());
  return args;
}

/** Resolves a token to a colour: hex, rgb(), var() and `color-mix(in srgb, …)`. */
export function resolveColor(name: string, vars: Declarations, seen: ReadonlySet<string> = new Set()): Rgba {
  if (seen.has(name)) throw new Error(`css: ${name} refers to itself`);
  const value = vars.get(name);
  if (value === undefined) throw new Error(`css: ${name} is not defined`);
  return evaluate(value, vars, new Set([...seen, name]));
}

function evaluate(value: string, vars: Declarations, seen: ReadonlySet<string>): Rgba {
  const v = value.trim();
  const ref = /^var\((--[\w-]+)\)$/.exec(v);
  if (ref?.[1]) return resolveColor(ref[1], vars, seen);
  const mix = /^color-mix\((.*)\)$/.exec(v);
  if (mix?.[1] !== undefined) {
    const [space, first, second] = splitArgs(mix[1]);
    if (space !== "in srgb" || first === undefined || second === undefined) {
      throw new Error(`css: unsupported color-mix "${v}"`);
    }
    const part = (arg: string) => {
      const weighted = /^(.*?)\s+([\d.]+)%$/.exec(arg);
      return weighted?.[1] && weighted[2]
        ? { colour: evaluate(weighted[1], vars, seen), weight: Number(weighted[2]) / 100 }
        : { colour: evaluate(arg, vars, seen), weight: undefined };
    };
    const a = part(first);
    const b = part(second);
    const weight = a.weight ?? (b.weight === undefined ? 0.5 : 1 - b.weight);
    return mixSrgb(a.colour, b.colour, weight);
  }
  return parseColor(v);
}
