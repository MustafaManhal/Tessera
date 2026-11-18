// `node scripts/release-manifest.mjs --version 0.1.0 --base-url <download url> --notes <file> --out latest.json <bundle dir>`
// writes the update manifest for a release from the signed update bundles in the directory.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { signedAssets, updateManifest } from "./release-lib.mjs";

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const opt = (name) => {
    const at = args.indexOf(name);
    return at === -1 ? undefined : args[at + 1];
  };
  const dir = args.find((arg, i) => !arg.startsWith("--") && !args[i - 1]?.startsWith("--"));
  const version = opt("--version");
  const baseUrl = opt("--base-url");
  if (!dir || !version || !baseUrl) {
    console.error(
      "usage: release-manifest.mjs --version <v> --base-url <url> [--notes <file>] [--out latest.json] <bundle dir>",
    );
    process.exit(2);
  }
  const notesFile = opt("--notes");
  const manifest = updateManifest({
    version,
    notes: notesFile ? readFileSync(notesFile, "utf8").trim() : "",
    date: new Date().toISOString(),
    baseUrl,
    assets: signedAssets(dir),
  });
  writeFileSync(opt("--out") ?? "latest.json", `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`wrote ${opt("--out") ?? "latest.json"} for ${Object.keys(manifest.platforms).join(", ")}`);
}
