// `pnpm rust:test`: Rust tests. On CI with cargo-nextest installed it runs the `ci` profile (bounded retries, no
// fail-fast, see .config/nextest.toml) plus doctests; everywhere else plain `cargo test --workspace`.
import { spawnSync } from "node:child_process";

const run = (args) => spawnSync("cargo", args, { stdio: "inherit", shell: process.platform === "win32" }).status ?? 1;
const hasNextest =
  spawnSync("cargo", ["nextest", "--version"], { stdio: "ignore", shell: process.platform === "win32" }).status === 0;

if (process.env.CI && hasNextest) {
  const status = run(["nextest", "run", "--workspace", "--profile", "ci"]);
  if (status !== 0) process.exit(status);
  process.exit(run(["test", "--workspace", "--doc"]));
}
process.exit(run(["test", "--workspace"]));
