// Start a local PTY test bridge and print its WebSocket URL, including the token.
// Keep this process running while Playwright uses the URL. Stop it with Ctrl-C
// or run "node scripts/bridge.mjs --stop" from a second terminal in this checkout.
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const key = createHash("sha256").update(root).digest("hex").slice(0, 24);
const directory = join(tmpdir(), `tessera-bridge-${key}`);
const stopFile = join(directory, "stop");
const arg = process.argv[2];
if (arg === "--stop") {
  if (existsSync(directory)) writeFileSync(stopFile, "", { mode: 0o600 });
} else {
  if (arg !== undefined && (!/^\d+$/.test(arg) || Number(arg) > 65535)) {
    throw new Error("Usage: node scripts/bridge.mjs [port|--stop]");
  }
  mkdirSync(directory, { mode: 0o700 });
  const token = randomBytes(32).toString("hex");
  const child = spawn(
    "cargo",
    ["run", "--locked", "-p", "tessera-pty", "--example", "pty_bridge", "--", ...(arg === undefined ? [] : [arg])],
    {
      cwd: root,
      env: { ...process.env, TESSERA_BRIDGE_TOKEN: token },
      stdio: ["pipe", "pipe", "inherit"],
    },
  );
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    const match = /^listening (\d+)$/.exec(line);
    if (match) console.log(`ws://127.0.0.1:${match[1]}/?token=${token}`);
  });
  const stop = () => child.stdin.end();
  const watcher = setInterval(() => {
    if (existsSync(stopFile)) stop();
  }, 100);
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  child.stdin.on("error", (error) => {
    if (error.code !== "EPIPE") console.error(error.message);
  });
  child.on("error", (error) => console.error(error.message));
  child.once("close", (code, signal) => {
    clearInterval(watcher);
    rmSync(directory, { recursive: true, force: true });
    process.exitCode = code ?? (signal === "SIGINT" ? 0 : 1);
  });
}
