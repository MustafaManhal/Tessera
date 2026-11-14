// `pnpm check:linux`: runs the Rust tests of the pure crates on Linux in Docker, from any OS. Use it when a test
// behaves differently on Ubuntu than on macOS (shell, PTY, path and locale differences). Needs Docker running.
//
//   pnpm check:linux                 all pure crates
//   pnpm check:linux -p tessera-shell --test real_shells     any `cargo test` arguments
import { spawnSync } from "node:child_process";

const extra = process.argv.slice(2);
const testArgs = extra.length ? extra : ["--workspace", "--exclude", "tessera-desktop"];
const script = [
  "apt-get update -qq >/dev/null 2>&1 && apt-get install -y -qq zsh fish >/dev/null 2>&1; true",
  `cargo test ${testArgs.map((arg) => `'${arg}'`).join(" ")}`,
].join(" && ");
const result = spawnSync(
  "docker",
  [
    "run",
    "--rm",
    "-v",
    `${process.cwd()}:/work`,
    "-w",
    "/work",
    "-e",
    "CARGO_TARGET_DIR=/tmp/target",
    "-v",
    "tessera-cargo-cache:/usr/local/cargo/registry",
    "rust:1.90",
    "bash",
    "-c",
    script,
  ],
  { stdio: "inherit" },
);
process.exit(result.status ?? 1);
