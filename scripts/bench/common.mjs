/** Benchmark helpers. macOS and Windows only. Release binary: pnpm build -- --no-bundle
 * (or pnpm --filter @tessera/desktop tauri build --no-bundle).
 * Set TESSERA_BENCH_BINARY to an absolute executable path to benchmark another build.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir, release, cpus } from "node:os";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEvents, parseProcesses, processTree, withoutShells } from "../lib/bench.mjs";
export const root = fileURLToPath(new URL("../../", import.meta.url));
if (!["darwin", "win32"].includes(process.platform)) throw Error("Tessera benchmarks support macOS and Windows only");
export function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024, ...options });
  if (result.error || result.status !== 0) throw Error(result.error?.message ?? result.stderr ?? `${command} failed`);
  return result.stdout;
}
export function cargo(args) {
  const output = run("cargo", args);
  process.stdout.write(output);
  return output;
}
export function metadata() {
  return {
    date: new Date().toISOString(),
    machine: cpus()[0]?.model,
    os: `${process.platform} ${release()}`,
    commit: run("git", ["rev-parse", "HEAD"]).trim(),
    dirty: run("git", ["status", "--porcelain"]).trim().length > 0,
  };
}
export async function until(read, predicate, timeout = process.platform === "win32" ? 90000 : 30000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await read();
    if (predicate(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw Error("Benchmark event deadline exceeded");
}
export async function launch({ profile } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "tessera-bench-"));
  const binary = resolve(
    process.env.TESSERA_BENCH_BINARY ??
      join(root, "target", "release", `tessera-desktop${process.platform === "win32" ? ".exe" : ""}`),
  );
  const started = performance.now();
  const epoch = Date.now();
  await writeFile(join(dir, "events.jsonl"), `${JSON.stringify({ event: "process_start", ms: 0, clock: "parent" })}\n`);
  const child = spawn(binary, [], {
    cwd: root,
    env: {
      ...process.env,
      TESSERA_BENCH_ROOT: dir,
      TESSERA_BENCH_PROCESS_START_UNIX_MS: String(epoch),
      ...(profile ? { TESSERA_BENCH_DATA_ROOT: profile } : {}),
      ...(process.platform === "darwin" && process.env.TESSERA_BENCH_DYLD === "1"
        ? { DYLD_PRINT_STATISTICS: "1", DYLD_PRINT_STATISTICS_DETAILS: "1" }
        : {}),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  let error;
  child.on("error", (e) => {
    error = e;
  });
  child.stdout.on("data", (d) => {
    output += d;
  });
  child.stderr.on("data", (d) => {
    output += d;
  });
  const read = async () => {
    if (error) throw error;
    if (child.exitCode !== null) throw Error(`App exited ${child.exitCode}: ${output}`);
    try {
      return parseEvents(await readFile(join(dir, "events.jsonl"), "utf8"));
    } catch (e) {
      if (e.code === "ENOENT") return [];
      throw e;
    }
  };
  return { child, dir, read, started, binary, output: () => output };
}
export async function ready(app, prompts = 1) {
  return until(
    app.read,
    (events) =>
      events.some((e) => e.event === "window") && events.filter((e) => e.event === "prompt").length >= prompts,
  );
}
export async function stop(app) {
  if (app.child.pid && app.child.exitCode === null && app.child.signalCode === null) {
    const exited = new Promise((resolve) => app.child.once("exit", resolve));
    if (process.platform === "win32") run("taskkill", ["/PID", String(app.child.pid), "/T", "/F"]);
    else app.child.kill("SIGTERM");
    let timer;
    await Promise.race([
      exited,
      new Promise((resolve) => {
        timer = setTimeout(() => {
          app.child.kill("SIGKILL");
          resolve();
        }, 5000);
      }),
    ]);
    clearTimeout(timer);
  }
  await writeFile(join(app.dir, "process.log"), app.output());
  // Keep result directories for evidence; remove only the disposable app profile after shutdown.
  await rm(join(app.dir, "data"), { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
export function processes() {
  if (process.platform === "darwin") return parseProcesses(run("ps", ["-axo", "pid=,ppid=,rss=,comm="]));
  return parseProcesses(
    run("powershell.exe", [
      "-NoProfile",
      "-Command",
      "$parents=@{}; Get-CimInstance Win32_Process | ForEach-Object {$parents[[int]$_.ProcessId]=[int]$_.ParentProcessId}; $private=@{}; Get-CimInstance Win32_PerfFormattedData_PerfProc_Process | ForEach-Object {$private[[int]$_.IDProcess]=[int64]$_.WorkingSetPrivate}; @(Get-Process | ForEach-Object { $ws = if ($private.ContainsKey($_.Id)) { $private[$_.Id] } else { $_.WorkingSet64 }; [pscustomobject]@{ProcessId=$_.Id; ParentProcessId=$parents[$_.Id]; WorkingSetSize=$ws; Name=$_.ProcessName} }) | ConvertTo-Json -Compress",
    ]),
    true,
  );
}
export function memory(pid) {
  const all = processTree(processes(), pid);
  if (!all.some((row) => row.pid === pid)) throw Error("App process missing");
  // The shells in the panes are the user's, not Tessera's (D-18).
  const tree = withoutShells(all);
  return {
    bytes: tree.reduce((sum, row) => sum + row.bytes, 0),
    tree,
    with_shells_bytes: all.reduce((sum, row) => sum + row.bytes, 0),
  };
}

// On Windows the memory of a process is its PRIVATE working set (what only it uses), not the working set, which also
// counts every DLL page shared with other processes: one WebView2 baseline read 570 MB that way (D-19).

/** macOS physical footprint of the process tree (what Activity Monitor calls Memory), in bytes; null elsewhere.
 * RSS also counts the system frameworks every app maps (about 90 MB for a webview app), which is not Tessera's. */
export function footprintBytes(tree) {
  if (process.platform !== "darwin") return null;
  let total = 0;
  for (const row of tree) {
    const result = spawnSync("footprint", ["-p", String(row.pid)], { encoding: "utf8" });
    const match = /Footprint:\s+([\d.]+)\s*(B|KB|MB|GB)/.exec(result.stdout ?? "");
    if (!match) continue;
    const unit = { B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3 }[match[2]];
    total += Number(match[1]) * unit;
  }
  return total;
}

/** Where results go: the planning workspace's research log when it exists, else `docs/benchmarks.md`. */
export function benchLogPath() {
  const research = join(root, ".ai/research");
  return existsSync(research) ? join(research, "bench.md") : join(root, "docs/benchmarks.md");
}

/** Append reproducible machine/build provenance and the result to the research log. */
export async function save(name, result) {
  await mkdir(dirname(benchLogPath()), { recursive: true });
  await appendFile(
    benchLogPath(),
    `\n### ${name} — ${new Date().toISOString()}\n\n\`\`\`json\n${JSON.stringify({ ...metadata(), ...result }, null, 2)}\n\`\`\`\n`,
  );
}
