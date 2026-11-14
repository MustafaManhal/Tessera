// `pnpm check`: the quick checks every commit must pass. Runs the steps in order, stops at the first failure and
// says which step failed. `pnpm check --from <step>` resumes from a step.
import { spawnSync } from "node:child_process";

const steps = ["format:check", "lint", "typecheck", "test", "rust:fmt", "rust:clippy", "rust:release", "rust:test"];

const fromIndex = process.argv.indexOf("--from");
const start = fromIndex === -1 ? 0 : steps.indexOf(process.argv[fromIndex + 1] ?? "");
if (start < 0) {
  console.error(`check: unknown step for --from. Steps: ${steps.join(", ")}`);
  process.exit(2);
}

for (const [i, step] of steps.entries()) {
  if (i < start) continue;
  console.log(`\n▶ check ${i + 1}/${steps.length}: ${step}`);
  const started = Date.now();
  const result = spawnSync("pnpm", ["run", "--silent", step], {
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  if (result.status !== 0) {
    console.error(
      `\n✖ check failed at step ${i + 1}/${steps.length}: ${step} (${seconds}s). Run \`pnpm ${step}\` to see it alone.`,
    );
    process.exit(result.status ?? 1);
  }
  console.log(`✔ ${step} (${seconds}s)`);
}
console.log(`\n✔ check passed: all ${steps.length} steps.`);
