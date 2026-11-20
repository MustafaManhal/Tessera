/** Run real project/task commands and events inside the debug desktop app against a disposable local repo.
 * Usage: node scripts/backend-smoke.mjs (requires port 1421 to be free).
 * Keeps its fixture, app log and result under the printed temporary path for review.
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { watch } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const root = await mkdtemp(join(tmpdir(), "tessera-backend-smoke-"));
const repo = join(root, "repo");
await mkdir(repo);
for (const args of [
  ["init", "-b", "main"],
  ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-m", "fixture"],
]) {
  const result = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr || "git fixture failed");
}
console.log(`Backend smoke fixture: ${root}`);
const resultFile = join(root, "smoke-result.json");
let child;
let watcher;
let timer;
let output = "";
try {
  const completion = new Promise((resolve, reject) => {
    watcher = watch(root, async (_event, name) => {
      if (String(name) !== "smoke-result.json") return;
      try {
        resolve(JSON.parse(await readFile(resultFile, "utf8")));
      } catch (error) {
        reject(error);
      }
    });
    timer = setTimeout(() => reject(new Error("Backend smoke deadline exceeded; inspect app.log")), 180000);
    child = spawn("pnpm", ["dev"], {
      env: { ...process.env, TESSERA_DEV_PORT: "1421", TESSERA_BACKEND_SMOKE_ROOT: root },
      detached: process.platform !== "win32",
      shell: process.platform === "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (data) => {
      output += data;
    });
    child.stderr.on("data", (data) => {
      output += data;
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code) reject(new Error(`Desktop exited ${code}; inspect app.log`));
    });
  });
  const result = await completion;
  console.log(JSON.stringify(result));
  if (!result.ok) process.exitCode = 1;
} finally {
  clearTimeout(timer);
  watcher?.close();
  if (child?.pid) {
    if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"]);
    else {
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        /* Already stopped. */
      }
    }
  }
  await writeFile(join(root, "app.log"), output);
}
