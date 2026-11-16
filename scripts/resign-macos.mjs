// Gives the macOS app a stable "designated requirement" so macOS keeps the permissions the user granted
// (microphone, camera, folders, notifications) across updates.
//
// Tessera ships ad hoc signed (D-13: no notarization). An ad hoc signature has no designated requirement, so macOS
// remembers permissions by the code hash of the exact build, and every update looks like a new app: it asks for the
// microphone again. This script signs the app again with `designated => identifier "dev.tessera.terminal"`, a
// requirement every later build satisfies, then rebuilds what was made from the first signature: the update bundle
// (`.app.tar.gz` and its `.sig`, needs TAURI_SIGNING_PRIVATE_KEY) and the `.dmg`.
//
// `node scripts/resign-macos.mjs <bundle dir>`, called by `scripts/package.mjs` on macOS.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync, symlinkSync, cpSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const APP_IDENTIFIER = "dev.tessera.terminal";
/** The requirement written into the app signature. */
export const REQUIREMENT = `designated => identifier "${APP_IDENTIFIER}"`;

/**
 * The requirement for a helper program (the session daemon `tesserad`, the CLI `tessera`). Terminals run under the
 * daemon, so macOS attributes a microphone or folder request from a program in a terminal to `tesserad`: its
 * permission must survive updates the same way the app's does.
 */
export function helperRequirement(name) {
  return `designated => identifier "${APP_IDENTIFIER}.${name}"`;
}

/** Arguments for the `codesign` calls, in order: helpers first, then the app (nested code must be valid first). */
export function signCommands(app, entitlements, helpers) {
  const calls = helpers.map((name) => [
    "--force",
    "--sign",
    "-",
    "--options",
    "runtime",
    "-i",
    `${APP_IDENTIFIER}.${name}`,
    "--entitlements",
    entitlements,
    `-r=${helperRequirement(name)}`,
    join(app, "Contents", "MacOS", name),
  ]);
  calls.push([
    "--force",
    "--sign",
    "-",
    "--options",
    "runtime",
    "--entitlements",
    entitlements,
    `-r=${REQUIREMENT}`,
    app,
  ]);
  return calls;
}

function find(dir, test, found = []) {
  if (!existsSync(dir)) return found;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (test(entry.name, entry.isDirectory())) found.push(path);
    else if (entry.isDirectory()) find(path, test, found);
  }
  return found;
}

export function resign(bundleDir) {
  const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: "inherit", ...opts });
  const entitlements = join(root, "apps/desktop/src-tauri/Entitlements.plist");
  const apps = find(bundleDir, (name, dir) => dir && name.endsWith(".app"));
  for (const app of apps) {
    const macos = join(app, "Contents", "MacOS");
    const helpers = readdirSync(macos).filter((name) => name === "tesserad" || name === "tessera");
    for (const args of signCommands(app, entitlements, helpers)) run("codesign", args);
    run("codesign", ["--verify", "--deep", "--strict", app]);
    console.log(`resign: ${app} signed with ${REQUIREMENT}`);
    const dir = dirname(app);
    for (const tar of readdirSync(dir).filter((f) => f.endsWith(".app.tar.gz"))) {
      run("tar", ["-czf", join(dir, tar), "-C", dir, app.slice(dir.length + 1)]);
      if (process.env.TAURI_SIGNING_PRIVATE_KEY) {
        run("pnpm", ["--filter", "@tessera/desktop", "tauri", "signer", "sign", join(dir, tar)], { cwd: root });
      }
    }
    const dmgDir = join(dirname(dir), "dmg");
    for (const dmg of existsSync(dmgDir) ? readdirSync(dmgDir).filter((f) => f.endsWith(".dmg")) : []) {
      const stage = mkdtempSync(join(tmpdir(), "tessera-dmg-"));
      cpSync(app, join(stage, app.slice(dir.length + 1)), { recursive: true, verbatimSymlinks: true });
      symlinkSync("/Applications", join(stage, "Applications"));
      rmSync(join(dmgDir, dmg));
      mkdirSync(dmgDir, { recursive: true });
      run("hdiutil", [
        "create",
        "-volname",
        "Tessera",
        "-srcfolder",
        stage,
        "-ov",
        "-format",
        "UDZO",
        join(dmgDir, dmg),
      ]);
      rmSync(stage, { recursive: true, force: true });
    }
  }
  if (apps.length === 0) console.log("resign: no .app found, nothing to do");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) resign(resolve(process.argv[2] ?? "target"));
