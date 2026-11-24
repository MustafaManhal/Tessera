/** Release build: pnpm --filter @tessera/desktop tauri build --no-bundle
 * 10 launches with a shared disposable profile: first run misses the environment cache, later runs can hit it.
 * JSONL phases are relative to the parent's process-start epoch; clocks are aligned at run entry (1 ms precision).
 * The shell interval begins when child exec returns and ends at raw read of OSC 133 B (before coalescing).
 * Our conservative share adds pre-shell time, post-spawn setup and raw-prompt-to-IPC delivery.
 * Host latency and first-output telemetry bound delivery cost; this is not a key-to-painted-glyph measurement.
 * User shell samples are separate evidence, never subtracted from unrelated app runs.
 */
// The startup marks come from the in-process PTY host; with `tesserad` next to the binary the app would use the
// session daemon and they would be missing. Measure the in-process path unless the caller says otherwise.
process.env.TESSERA_SESSION_DAEMON ??= "0";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launch, ready, stop, metadata, save, run } from "./common.mjs";
import { percentile, coldStartBreakdown } from "../lib/bench.mjs";
const label = process.env.TESSERA_BENCH_LABEL ?? "default";
console.log({ ...metadata(), label });
if (process.platform === "darwin") {
  const modes = { login: ["-lic", "exit"], minimal: ["-f", "-c", "exit"] };
  const measurements = {};
  for (const [mode, args] of Object.entries(modes)) {
    const samples = [];
    for (let i = 0; i < 10; i++) {
      const start = performance.now();
      run("/bin/zsh", args, { timeout: 15000 });
      samples.push(performance.now() - start);
    }
    measurements[mode] = {
      median_ms: percentile(samples, 0.5),
      p95_ms: percentile(samples, 0.95),
      samples_ms: samples,
    };
  }
  console.log(JSON.stringify({ shell_alone: measurements }));
  await save("Zsh alone (10 runs each)", measurements);
}
const profile = await mkdtemp(join(tmpdir(), "tessera-cold-profile-"));
const samples = [];
try {
  for (let i = 0; i < 10; i++) {
    const app = await launch({ profile });
    try {
      const events = await ready(app);
      const breakdown = coldStartBreakdown(events);
      samples.push(breakdown);
      console.log(
        JSON.stringify({
          label,
          run: i + 1,
          ...breakdown,
          cache_hit: events.some((e) => e.event === "login_cache_hit"),
          evidence: app.dir,
        }),
      );
    } finally {
      await stop(app);
    }
  }
  const summary = (key) => ({
    median_ms: percentile(
      samples.map((s) => s[key]),
      0.5,
    ),
    p95_ms: percentile(
      samples.map((s) => s[key]),
      0.95,
    ),
  });
  const result = {
    label,
    runs: 10,
    total: summary("launch_to_prompt_ms"),
    our_to_shell: summary("our_to_shell_ms"),
    our_total: summary("our_total_ms"),
    delivery: summary("delivery_ms"),
    post_spawn_host: summary("post_spawn_host_ms"),
    shell_interval: summary("shell_to_prompt_ms"),
    budget_ms: process.platform === "darwin" ? 600 : 1000,
    samples,
  };
  console.log(JSON.stringify(result));
  await save(`Cold start breakdown: ${label}`, result);
} finally {
  await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
