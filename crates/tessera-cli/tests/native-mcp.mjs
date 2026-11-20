// Opt-in native proof. Start the debug app with the same disposable TESSERA_BENCH_ROOT first.
// Supply TESSERA_SOCKET and TESSERA_SHOTS_DIR explicitly; no default user data/config paths are used.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout } from "node:timers/promises";
assert(process.env.TESSERA_BENCH_ROOT, "An explicit disposable root is required");
const root = resolve(process.env.TESSERA_BENCH_ROOT);
const tempRoots = [tmpdir(), ...(process.platform === "darwin" ? ["/tmp", "/private/tmp"] : [])];
assert(
  tempRoots.some((temp) => {
    const inside = relative(temp, root);
    return inside && !inside.startsWith("..") && !isAbsolute(inside);
  }),
  "An explicit disposable root under the system temp folder is required",
);
assert(process.env.TESSERA_SOCKET && process.env.TESSERA_SHOTS_DIR, "Explicit socket and shots directory required");
const data = join(root, "data");
assert(existsSync(join(data, "api-token")), "Start the native debug app against this root first");
const binary = fileURLToPath(
  new URL(`../../../target/debug/tessera${process.platform === "win32" ? ".exe" : ""}`, import.meta.url),
);
const env = { ...process.env, TESSERA_API_TOKEN_FILE: join(data, "api-token") };
delete env.TESSERA_ASKPASS_ALIAS;
const cli = (...args) =>
  JSON.parse(execFileSync(binary, [...args, "--json"], { env, encoding: "utf8", timeout: 10_000 }));
const saveSwitch = async (enabled) => {
  writeFileSync(join(data, "config.toml"), `[api]\nsocket = true\nmcp-server = ${enabled}\n`);
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const info = cli("info");
    if (info.mcp_server === enabled) return info;
    await setTimeout(100);
  }
  throw Error("Native settings watcher did not apply the MCP switch");
};
const disabledInfo = await saveSwitch(false);
const startDisabled = () => {
  const result = spawnSync(binary, ["mcp"], { env, input: "", encoding: "utf8", timeout: 5_000 });
  assert.equal(result.status, 2);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /api\.mcp-server/);
  return { exitCode: result.status, stderr: result.stderr, stdout: result.stdout };
};
const disabled = startDisabled();
const enabledInfo = await saveSwitch(true);
const repo = join(root, "repo");
mkdirSync(repo, { recursive: true });
if (!existsSync(join(repo, ".git"))) {
  execFileSync("git", ["init", "-b", "main", repo], { stdio: "pipe" });
  execFileSync("git", ["-C", repo, "config", "user.name", "Fixture"]);
  execFileSync("git", ["-C", repo, "config", "user.email", "fixture@example.invalid"]);
  writeFileSync(join(repo, "README.md"), "MCP native fixture\n");
  execFileSync("git", ["-C", repo, "add", "README.md"]);
  execFileSync("git", ["-C", repo, "commit", "-m", "fixture"], { stdio: "pipe" });
}
if (!cli("project", "ls").some((p) => realpathSync(p.path) === realpathSync(repo))) cli("project", "add", repo);
const requests = [
  {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "tessera-native-proof", version: "1" },
    },
  },
  { jsonrpc: "2.0", method: "notifications/initialized" },
  { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
  { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "list_projects", arguments: {} } },
  { jsonrpc: "2.0", id: 4, method: "ping", params: {} },
];
const result = spawnSync(binary, ["mcp"], {
  env,
  input: `${requests.map((r) => JSON.stringify(r)).join("\n")}\n`,
  encoding: "utf8",
  timeout: 10_000,
});
assert.equal(result.status, 0, result.stderr);
assert.equal(result.stderr, "");
const responses = result.stdout
  .trim()
  .split("\n")
  .map((line) => JSON.parse(line));
assert.deepEqual(
  responses.map((r) => r.id),
  [1, 2, 3, 4],
);
assert.equal(responses[0].result.protocolVersion, "2025-06-18");
assert.equal(responses[1].result.tools.length, 8);
assert.equal(responses[2].result.isError, false);
const projects = JSON.parse(responses[2].result.content[0].text);
assert(projects.some((p) => realpathSync(p.path) === realpathSync(repo)));
const afterDisabledInfo = await saveSwitch(false);
const afterDisabled = startDisabled();
const shots = resolve(process.env.TESSERA_SHOTS_DIR);
mkdirSync(shots, { recursive: true });
writeFileSync(join(shots, "native-tools-list.json"), `${JSON.stringify(responses[1], null, 2)}\n`);
writeFileSync(join(shots, "native-list-projects.json"), `${JSON.stringify(responses[2], null, 2)}\n`);
writeFileSync(
  join(shots, "native-mcp-lifecycle.json"),
  `${JSON.stringify({ ok: true, source: "native debug app and real CLI, no --force", disabledInfo, disabled, enabledInfo, requests, responses, afterDisabledInfo, afterDisabled }, null, 2)}\n`,
);
console.log("Native MCP proof passed: disabled exit 2, enabled initialize/list/tools call, disable again exit 2.");
