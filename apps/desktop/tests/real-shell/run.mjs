import { spawn } from "node:child_process";
import { accessSync, constants, existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const desktopDir = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const root = resolve(desktopDir, "../..");
const bridgeMode = process.env.BRIDGE ?? "mock";
const bridgeToken = process.env.TESSERA_BRIDGE_TOKEN ?? randomBytes(32).toString("hex");
const devPort = process.env.TESSERA_DEV_PORT ?? "1422";

if (bridgeMode !== "mock" && bridgeMode !== "real") {
  throw new Error("BRIDGE must be either 'mock' or 'real'");
}

if (bridgeMode === "real" && process.platform !== "darwin" && process.platform !== "win32") {
  throw new Error("The real-shell runner supports macOS and Windows only");
}

async function unusedPort() {
  const server = createServer();
  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not reserve a PTY bridge port");
  await new Promise((resolveClose, reject) => server.close((error) => (error ? reject(error) : resolveClose())));
  return address.port;
}

function selectedShells() {
  if (bridgeMode !== "real") return [undefined];
  if (process.platform === "win32") return ["pwsh.exe"];
  return ["/bin/zsh", "/bin/bash"].filter((shell) => {
    if (!existsSync(shell)) return false;
    try {
      accessSync(shell, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}

function waitForBridge(child, port) {
  return new Promise((resolveReady, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error(`PTY bridge did not announce readiness on port ${port}`)), 30_000);
    const onData = (chunk) => {
      output += chunk.toString();
      const announcedUrl = output.match(/ws:\/\/127\.0\.0\.1:\d+(?:\/\?token=[A-Za-z0-9._~+%=-]+)?/)?.[0];
      const ready =
        bridgeMode === "mock"
          ? new RegExp(`listening ${port}\\b`).test(output)
          : Boolean(announcedUrl) || /listening \d+/.test(output);
      if (ready) {
        clearTimeout(timer);
        const url = announcedUrl ? new URL(announcedUrl) : null;
        resolveReady({
          port: url?.port ? Number(url.port) : port,
          token: url?.searchParams.get("token") ?? bridgeToken,
        });
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`PTY bridge exited before readiness (code ${code}): ${output}`));
    });
  });
}

const bridgePort = Number(process.env.TESSERA_BRIDGE_PORT ?? (await unusedPort()));
const bridgeScript =
  bridgeMode === "mock" ? resolve(desktopDir, "tests/real-shell/mock-bridge.mjs") : resolve(root, "scripts/bridge.mjs");
const bridgeArgs =
  bridgeMode === "mock" ? [bridgeScript, "--port", String(bridgePort), "--token", bridgeToken] : [bridgeScript];
const binary =
  bridgeMode === "real" && process.env.TESSERA_BRIDGE_BINARY ? resolve(root, process.env.TESSERA_BRIDGE_BINARY) : null;
const bridge = spawn(binary ?? process.execPath, binary ? [String(bridgePort)] : bridgeArgs, {
  cwd: root,
  env: {
    ...process.env,
    TESSERA_BRIDGE_PORT: String(bridgePort),
    TESSERA_BRIDGE_TOKEN: bridgeToken,
  },
  stdio: [binary ? "pipe" : "ignore", "pipe", "pipe"],
  windowsHide: true,
});

let testExit = 1;
try {
  const { port: activePort, token: activeToken } = await waitForBridge(bridge, bridgePort);
  const shells = selectedShells();
  if (shells.length === 0) throw new Error("No supported shell was found for the real-shell run");
  for (const shell of shells) {
    const test = spawn(
      process.execPath,
      [
        resolve(root, "node_modules/@playwright/test/cli.js"),
        "test",
        "-c",
        resolve(desktopDir, "playwright.real-shell.config.ts"),
      ],
      {
        cwd: root,
        env: {
          ...process.env,
          BRIDGE: bridgeMode,
          TESSERA_DEV_PORT: devPort,
          TESSERA_BRIDGE_PORT: String(activePort),
          TESSERA_BRIDGE_TOKEN: activeToken,
          TESSERA_REAL_SHELL: shell,
        },
        stdio: "inherit",
      },
    );
    testExit = await new Promise((resolveExit, reject) => {
      test.once("error", reject);
      test.once("exit", (code, signal) => resolveExit(code ?? (signal ? 1 : 0)));
    });
    if (testExit !== 0) break;
  }
} finally {
  const bridgeExited =
    bridge.exitCode !== null || bridge.signalCode !== null
      ? Promise.resolve(true)
      : new Promise((resolveExit) => bridge.once("close", () => resolveExit(true)));
  if (binary) {
    bridge.stdin?.on("error", () => {});
    bridge.stdin?.end();
  } else if (bridgeMode === "real") {
    // Windows terminates Node on SIGTERM without running its handlers. Ask the
    // wrapper to close the Rust child's stdin and remove its lock directory first.
    const stop = spawn(process.execPath, [bridgeScript, "--stop"], { cwd: root, stdio: "ignore", windowsHide: true });
    await new Promise((resolveExit, reject) => {
      stop.once("error", reject);
      stop.once("exit", (code) => {
        if (code !== 0) reject(new Error(`Bridge cleanup failed with exit code ${code}`));
        else resolveExit();
      });
    });
  } else {
    bridge.kill("SIGTERM");
  }
  if (!(await Promise.race([bridgeExited, delay(5_000).then(() => false)]))) bridge.kill("SIGKILL");
}
process.exitCode = testExit;
