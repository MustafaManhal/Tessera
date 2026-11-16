// `pnpm package [--debug] [--target <triple|universal-apple-darwin>] [--updater] [-- <extra tauri build args>]`:
// builds the installers with the two helper programs inside.
//
// - `tesserad`, the session daemon: terminals and agents keep running when the app quits or updates (M8);
// - `tessera`, the CLI: agent status hooks (M6.4), SSH password hand-off (M10.1) and the PATH install (M6.3).
//
// Tauri ships extra programs through `bundle.externalBin`, which needs each binary under `src-tauri/binaries/` with the
// target triple in its name before the build starts. Putting `externalBin` in tauri.conf.json would make every plain
// `cargo build` and test fail until those files exist, so it is added here, for packaging only. At runtime the app
// finds both next to its own executable (`sessions::daemon_executable`, `hooks_commands::cli_path`).
//
// `--target universal-apple-darwin` builds both Mac architectures and joins the helpers with `lipo`.
// `--updater` also writes the signed update bundles (needs TAURI_SIGNING_PRIVATE_KEY in the environment).
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resign } from "./resign-macos.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** The Rust targets whose helpers have to exist for a Tauri `--target` value. */
export function helperTargets(target, host) {
  if (target === "universal-apple-darwin") return ["aarch64-apple-darwin", "x86_64-apple-darwin"];
  return [target ?? host];
}

/** The override that adds the helpers (and the update bundles) to the bundle config. */
export function bundleOverride({ updater }) {
  return {
    bundle: {
      externalBin: ["binaries/tesserad", "binaries/tessera"],
      // Stops a still-running session daemon before the installer replaces its files (Windows).
      windows: { nsis: { installerHooks: join(root, "apps/desktop/src-tauri/windows/installer-hooks.nsh") } },
      ...(updater ? { createUpdaterArtifacts: true } : {}),
    },
  };
}

function main() {
  const args = process.argv.slice(2).filter((arg) => arg !== "--");
  const debug = args.includes("--debug");
  const updater = args.includes("--updater");
  const targetAt = args.indexOf("--target");
  const target = targetAt === -1 ? undefined : args[targetAt + 1];
  const extra = args.filter(
    (arg, i) => !["--debug", "--updater", "--target"].includes(arg) && (targetAt === -1 || i !== targetAt + 1),
  );
  const windows = process.platform === "win32";
  const run = (command, commandArgs) =>
    execFileSync(command, commandArgs, { cwd: root, stdio: "inherit", shell: windows });

  const host = /^host: (\S+)$/m.exec(execFileSync("rustc", ["-vV"], { encoding: "utf8" }))?.[1];
  if (!host) throw new Error("package: could not read the Rust host target from `rustc -vV`");
  const exe = windows ? ".exe" : "";
  const profile = debug ? "debug" : "release";
  const binaries = join(root, "apps/desktop/src-tauri/binaries");
  mkdirSync(binaries, { recursive: true });

  const built = [];
  for (const triple of helperTargets(target, host)) {
    const explicit = triple !== host || target !== undefined;
    run("cargo", [
      "build",
      "-p",
      "tesserad",
      "-p",
      "tessera-cli",
      ...(explicit ? ["--target", triple] : []),
      ...(debug ? [] : ["--release"]),
    ]);
    const dir = join(root, "target", ...(explicit ? [triple] : []), profile);
    built.push([triple, dir]);
  }
  for (const [built_name, name] of [
    ["tesserad", "tesserad"],
    ["tessera", "tessera"],
  ]) {
    for (const [triple, dir] of built)
      copyFileSync(join(dir, `${built_name}${exe}`), join(binaries, `${name}-${triple}${exe}`));
    if (target === "universal-apple-darwin") {
      run("lipo", [
        "-create",
        "-output",
        join(binaries, `${name}-universal-apple-darwin`),
        ...built.map(([triple]) => join(binaries, `${name}-${triple}`)),
      ]);
    }
  }

  const override = join(tmpdir(), `tessera-package-${process.pid}.json`);
  writeFileSync(override, JSON.stringify(bundleOverride({ updater })));
  run("pnpm", [
    "--filter",
    "@tessera/desktop",
    "tauri",
    "build",
    ...(debug ? ["--debug"] : []),
    ...(target ? ["--target", target] : []),
    "--config",
    override,
    ...extra,
  ]);
  // macOS: a stable designated requirement, so permissions survive updates (see resign-macos.mjs).
  if (process.platform === "darwin") resign(join(root, "target", ...(target ? [target] : []), profile, "bundle"));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
