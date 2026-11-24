// `pnpm check:cross`: lints the Rust code of the OTHER platforms from this machine, so cfg-gated mistakes (imports
// used only on macOS, Windows-only loops) fail here and not on CI. Clippy compiles `cfg(windows)` code without
// linking, so it needs no Windows machine.
//
//   Windows: x86_64-pc-windows-gnu, which reaches every crate (needs mingw-w64 for the C dependencies such as SQLite;
//            macOS: `brew install mingw-w64`). Without mingw it falls back to the msvc target and only the pure-Rust
//            crates, and says so.
//   Linux:   not covered here, use `pnpm check:linux` (Docker).
//
// CI stays the final authority (linking, ConPTY behaviour, timing). Run this before every push that touches Rust.
import { spawnSync } from "node:child_process";

const run = (command, args) => spawnSync(command, args, { stdio: "inherit", shell: process.platform === "win32" });
const has = (command) =>
  spawnSync(process.platform === "win32" ? "where" : "which", [command], { stdio: "ignore" }).status === 0;

if (process.platform === "win32") {
  console.log("check:cross: already on Windows, nothing to do (pnpm check covers it).");
  process.exit(0);
}

const mingw = has("x86_64-w64-mingw32-gcc");
const target = mingw ? "x86_64-pc-windows-gnu" : "x86_64-pc-windows-msvc";
const scope = mingw
  ? ["--workspace"]
  : [
      "-p",
      "tessera-pty",
      "-p",
      "tessera-git",
      "-p",
      "tessera-shell",
      "-p",
      "tesserad",
      "-p",
      "tessera-agents",
      "-p",
      "tessera-api",
      "-p",
      "tessera-cli",
    ];
if (!mingw) {
  console.warn(
    "check:cross: mingw-w64 not found, linting only the pure-Rust crates with the msvc target.\n" +
      "             Install it for full coverage: brew install mingw-w64",
  );
}
if (run("rustup", ["target", "add", target]).status !== 0) process.exit(1);
console.log(`\n▶ check:cross clippy for ${target}`);
const result = run("cargo", ["clippy", ...scope, "--all-targets", "--target", target, "--", "-D", "warnings"]);
if (result.status !== 0) {
  console.error(`\n✖ check:cross failed: Windows-only code does not lint clean. Fix it before pushing.`);
  process.exit(result.status ?? 1);
}
console.log("\n✔ check:cross passed.");
