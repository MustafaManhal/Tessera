// `node scripts/update-notes.mjs --version 0.1.18 [--out notes.txt]` writes the update manifest's notes: the What's new
// entries of that release only, so the Updates page shows what the new version brings and not the releases before it.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { updateNotes, whatsNewReleases } from "./release-lib.mjs";

const args = process.argv.slice(2);
const opt = (name) => {
  const at = args.indexOf(name);
  return at === -1 ? undefined : args[at + 1];
};
const version = opt("--version")?.replace(/^v/, "");
if (!version) {
  console.error("usage: update-notes.mjs --version <v> [--out <file>]");
  process.exit(2);
}
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = readFileSync(join(root, "apps/desktop/src/updates/whatsnew.ts"), "utf8");
const text = `${updateNotes(whatsNewReleases(source), version)}\n`;
const out = opt("--out");
if (out) writeFileSync(out, text);
else process.stdout.write(text);
