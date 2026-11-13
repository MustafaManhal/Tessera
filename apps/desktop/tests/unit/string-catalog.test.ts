import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

// The string catalog is the only place user-facing words live (NFR-12): no literal words in JSX text or in the
// attributes that people read or hear, and every `t("key")` names a key that exists.
const DESKTOP = fileURLToPath(new URL("../../", import.meta.url));
const ROOTS = [join(DESKTOP, "src"), join(DESKTOP, "../../packages/ui/src/components")];
const ATTRS = new Set([
  "label",
  "title",
  "placeholder",
  "aria-label",
  "alt",
  "aria-description",
  "aria-roledescription",
  "message",
  "description",
  "tooltip",
]);
/** Text that is code, a path or a product name, not a sentence to translate. */
const ALLOWED = [
  /^Tessera$/,
  /^Esc$/,
  /^tessera mcp$/,
  /^[~/.\w-]*\/[\w./-]*$/, // paths such as ~/code/shop-api or src/
  /^(main|README\.md|run\.sh|build\.zip|selected text)$/, // the theme picker's sample terminal
  /^[+-] const /, // sample diff lines
  /^https?:\/\//,
  /^--?[\w-]+/, // command line flags
  /^mycli/,
  /^ready>/,
  /^owner\/name$/,
  /^git, review$/,
];

function* sourceFiles(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (name === "dev" || name === "node_modules") continue;
      yield* sourceFiles(path);
    } else if (/\.tsx?$/.test(name)) yield path;
  }
}

function parse(file: string): ts.SourceFile {
  return ts.createSourceFile(
    file,
    readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
}

describe("string catalog", () => {
  it("has no literal words in JSX text or readable attributes", () => {
    const found: string[] = [];
    for (const root of ROOTS) {
      for (const file of sourceFiles(root)) {
        if (!file.endsWith(".tsx")) continue;
        const source = parse(file);
        const report = (node: ts.Node, text: string) => {
          if (!/[A-Za-z]{2,}/.test(text) || ALLOWED.some((pattern) => pattern.test(text))) return;
          found.push(
            `${file}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1} "${text.slice(0, 60)}"`,
          );
        };
        const visit = (node: ts.Node) => {
          if (ts.isJsxText(node)) report(node, node.getText().trim());
          if (
            ts.isJsxAttribute(node) &&
            ATTRS.has(node.name.getText()) &&
            node.initializer &&
            ts.isStringLiteral(node.initializer)
          )
            report(node, node.initializer.text);
          ts.forEachChild(node, visit);
        };
        visit(source);
      }
    }
    expect(found).toEqual([]);
  });

  it("every t('key') names a key in the catalog", () => {
    const catalog = readFileSync(join(DESKTOP, "../../packages/ui/src/strings.ts"), "utf8");
    const keys = new Set([...catalog.matchAll(/^\s+"([^"]+)":/gm)].map((m) => m[1]));
    expect(keys.size).toBeGreaterThan(500);
    const missing: string[] = [];
    for (const root of ROOTS) {
      for (const file of sourceFiles(root)) {
        const source = parse(file);
        const visit = (node: ts.Node) => {
          if (
            ts.isCallExpression(node) &&
            ts.isIdentifier(node.expression) &&
            node.expression.text === "t" &&
            node.arguments[0] &&
            ts.isStringLiteral(node.arguments[0]) &&
            !keys.has(node.arguments[0].text)
          )
            missing.push(`${file}: t("${node.arguments[0].text}")`);
          ts.forEachChild(node, visit);
        };
        visit(source);
      }
    }
    expect(missing).toEqual([]);
  });
});
