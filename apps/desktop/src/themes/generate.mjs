// One-off generator for `iterm2-schemes.json` (run by hand; the output is committed). Usage:
//   node apps/desktop/src/themes/generate.mjs <path to a checkout of mbadolato/iTerm2-Color-Schemes>
// It reads the repo's `windowsterminal/*.json` files (one scheme each, the same colours as the iTerm2 ones) and writes a
// compact JSON array: [name, background, foreground, cursor, selection, [16 ANSI colours]], colours as 6 hex digits
// without "#". Source, commit and licence are recorded in README.md next to this file.
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repo = process.argv[2];
if (!repo) {
  console.error("usage: node generate.mjs <iTerm2-Color-Schemes checkout>");
  process.exit(1);
}
const dir = join(repo, "windowsterminal");
const ANSI = [
  "black",
  "red",
  "green",
  "yellow",
  "blue",
  "purple",
  "cyan",
  "white",
  "brightBlack",
  "brightRed",
  "brightGreen",
  "brightYellow",
  "brightBlue",
  "brightPurple",
  "brightCyan",
  "brightWhite",
];
const hex = (value) => {
  const match = /^#?([0-9a-f]{6})$/i.exec(String(value ?? "").trim());
  return match ? match[1].toLowerCase() : null;
};

const rows = [];
for (const file of readdirSync(dir)
  .filter((name) => name.endsWith(".json"))
  .sort((a, b) => a.localeCompare(b))) {
  const scheme = JSON.parse(readFileSync(join(dir, file), "utf8"));
  const ansi = ANSI.map((key) => hex(scheme[key]));
  const background = hex(scheme.background);
  const foreground = hex(scheme.foreground);
  if (!scheme.name || !background || !foreground || ansi.some((c) => c === null)) {
    console.error(`skipped ${file}`);
    continue;
  }
  rows.push([
    scheme.name,
    background,
    foreground,
    hex(scheme.cursorColor) ?? foreground,
    hex(scheme.selectionBackground) ?? foreground,
    ansi,
  ]);
}
const out = fileURLToPath(new URL("./iterm2-schemes.json", import.meta.url));
writeFileSync(out, `${JSON.stringify(rows)}\n`);
let commit = "unknown";
try {
  commit = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"]).toString().trim();
} catch {}
console.log(`${rows.length} themes, commit ${commit}`);
