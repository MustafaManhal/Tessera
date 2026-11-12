// Starts the Tauri dev app on this checkout's port, so the lead (1420), worker-1 (1421) and worker-2 (1422)
// can run side by side. Usage: TESSERA_DEV_PORT=1421 pnpm dev
import { spawn, spawnSync } from "node:child_process";
import { resolveDevPort } from "./lib/port.mjs";

const port = resolveDevPort(process.env.TESSERA_DEV_PORT);
// The session daemon lives next to the app executable (target/debug); build it so TESSERA_SESSION_DAEMON=1 works.
const daemon = spawnSync("cargo", ["build", "-p", "tesserad"], {
  stdio: "inherit",
  shell: process.platform === "win32",
});
if (daemon.status !== 0) console.warn("dev: could not build tesserad; terminal sessions will run in the app.");
const config = JSON.stringify({ build: { devUrl: `http://localhost:${port}` } });
const child = spawn("pnpm", ["--filter", "@tessera/desktop", "tauri", "dev", "--config", config], {
  stdio: "inherit",
  shell: process.platform === "win32",
  env: { ...process.env, TESSERA_DEV_PORT: String(port) },
});
child.on("exit", (code) => process.exit(code ?? 0));
