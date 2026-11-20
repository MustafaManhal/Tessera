/** NFR-13 scale scenario: 50 concurrent panes (real terminals and PTYs opened through the split shortcut).
 * Release build, then `pnpm bench:scale`. Reports how long it takes until 50 prompts exist, the memory at 50 panes,
 * and the idle CPU of the app afterwards. The gate: every pane reaches its prompt, memory per extra pane stays at
 * 25 MB or less, and the app is quiet (under 15 % of one core) when idle.
 */
import { spawnSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { footprintBytes, launch, memory, metadata, ready, save, stop } from "./common.mjs";

const PANES = Number(process.env.TESSERA_BENCH_PANES ?? 50);
console.log(metadata());
const app = await launch();
try {
  await ready(app);
  const one = memory(app.child.pid);
  const oneFootprint = footprintBytes(one.tree);
  const started = Date.now();
  await writeFile(join(app.dir, "panes"), String(PANES));
  await ready(app, PANES);
  const seconds = (Date.now() - started) / 1000;
  // Let output and layout settle, then sample memory and CPU.
  await new Promise((resolve) => setTimeout(resolve, 5000));
  const many = memory(app.child.pid);
  const manyFootprint = footprintBytes(many.tree);
  const cpu = Number(
    process.platform === "win32"
      ? 0
      : spawnSync("ps", ["-o", "%cpu=", "-p", String(app.child.pid)], { encoding: "utf8" }).stdout.trim() || 0,
  );
  const base = oneFootprint ?? one.bytes;
  const top = manyFootprint ?? many.bytes;
  const perExtra = (top - base) / (PANES - 1) / 1000000;
  const result = {
    panes: PANES,
    seconds_to_all_prompts: seconds,
    metric: oneFootprint === null ? "working set / RSS" : "physical footprint",
    one_pane_MB: base / 1000000,
    many_panes_MB: top / 1000000,
    MB_per_extra_pane: perExtra,
    rss_many_panes_MB: many.bytes / 1000000,
    idle_cpu_percent: cpu,
    pass: perExtra <= 25 && cpu < 15,
    evidence: app.dir,
  };
  await save(`Scale ${PANES} panes`, result);
  console.log(JSON.stringify(result));
} finally {
  await stop(app);
}
