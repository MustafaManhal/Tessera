// `node scripts/size-check.mjs [bundle dir]`: fails when an installer is over 25 MB (NFR-05). Used by the release
// workflow and by `release-dry-run.mjs`.
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { installers, MAX_INSTALLER_BYTES, oversized } from "./release-lib.mjs";

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dir = resolve(process.argv[2] ?? "target/release/bundle");
  if (!existsSync(dir)) {
    console.error(`size check: ${dir} does not exist; build the installers first`);
    process.exit(2);
  }
  const files = installers(dir);
  if (files.length === 0) {
    console.error(`size check: no installers under ${dir}`);
    process.exit(2);
  }
  for (const file of files) console.log(`${(file.bytes / 1e6).toFixed(1)} MB  ${file.path}`);
  const over = oversized(files);
  if (over.length > 0) {
    console.error(
      `size check failed: over ${MAX_INSTALLER_BYTES / 1e6} MB:\n${over.map((f) => `  ${f.path}`).join("\n")}`,
    );
    process.exit(1);
  }
  console.log(`size check: every installer is within ${MAX_INSTALLER_BYTES / 1e6} MB`);
}
