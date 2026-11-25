// `node scripts/release-dry-run.mjs`: builds the installers for THIS machine (no signing key needed, nothing is
// uploaded or published) and prints their sizes against the 25 MB limit. The real release is the Release workflow.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { installers, MAX_INSTALLER_BYTES, oversized } from "./release-lib.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const windows = process.platform === "win32";
// On macOS only the app bundle is built by the packager here and the .dmg is made with hdiutil directly: Tauri's own
// .dmg step styles the window through Finder (AppleScript), which needs a logged-in desktop and would move windows on
// screen. The release workflow uses Tauri's .dmg on a CI runner. Sizes are comparable (compressed UDZO image).
const bundles = process.platform === "darwin" ? "app" : "nsis";
execFileSync("node", ["scripts/package.mjs", "--", "--bundles", bundles], {
  cwd: root,
  stdio: "inherit",
  shell: windows,
});
if (process.platform === "darwin") {
  const app = join(root, "target/release/bundle/macos/Tessera.app");
  const out = join(root, "target/release/bundle/dmg");
  mkdirSync(out, { recursive: true });
  execFileSync(
    "hdiutil",
    ["create", "-volname", "Tessera", "-srcfolder", app, "-ov", "-format", "UDZO", join(out, "Tessera-dry-run.dmg")],
    {
      stdio: "inherit",
    },
  );
}
const dir = join(root, "target/release/bundle");
if (!existsSync(dir)) throw new Error(`no bundle folder at ${dir}`);
const files = installers(dir);
for (const file of files) console.log(`${(file.bytes / 1e6).toFixed(1)} MB  ${file.path}`);
const over = oversized(files);
console.log(
  over.length === 0
    ? `every installer is within ${MAX_INSTALLER_BYTES / 1e6} MB`
    : `OVER the limit: ${over.map((f) => f.path).join(", ")}`,
);
process.exit(over.length === 0 && files.length > 0 ? 0 : 1);
