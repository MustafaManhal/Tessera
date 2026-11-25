/** Debug-only native verification, against the app started by the worker on port 1421.
 * mkdir -p /tmp/tessera-native; echo '{"sequence":0}' > /tmp/tessera-native/request.json
 * TESSERA_NATIVE_SMOKE_ROOT=/tmp/tessera-native TESSERA_DEV_PORT=1421 pnpm dev
 * node scripts/bench/native-smoke.mjs /tmp/tessera-native /absolute/screenshot/folder
 * Only this fixture directory is used; the debug harness is absent in release builds.
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { run, until } from "./common.mjs";
const dir = resolve(process.argv[2]);
const out = resolve(process.argv[3]);
await mkdir(out, { recursive: true });
const evidence = [];
let sequence = Date.now();
async function response() {
  try {
    return JSON.parse(await readFile(join(dir, "response.json"), "utf8"));
  } catch {
    return null;
  }
}
await until(response, (r) => r !== null);
async function call(command, args = {}) {
  const n = ++sequence;
  await writeFile(join(dir, "request.json"), JSON.stringify({ sequence: n, command, ...args }));
  const result = await until(response, (r) => r?.sequence === n);
  if (result.result.Err) throw Error(JSON.stringify(result.result.Err));
  evidence.push({ command, ...args, ...result });
  console.log(JSON.stringify(evidence.at(-1)));
  return result.result.Ok;
}
function check(value, message) {
  if (!value) throw Error(message);
}
try {
  await call("secure", { enabled: false });
  await call("secure", { enabled: false });
  await call("focus");
  await until(
    () => call("state"),
    (r) => r.focused && !r.minimized,
  );
  await call("progress", { state: "normal", value: 57 });
  const enabled = await call("secure", { enabled: true });
  if (process.platform === "darwin") check(enabled.secure.enabled, "Enable did not activate Carbon");
  await call("secure", { enabled: true });
  const nested = await call("secure", { enabled: false });
  if (process.platform === "darwin") {
    check(nested.secure.enabled, "One release lost nested ownership");
    const registry = run("ioreg", ["-l", "-w", "0"]);
    const pid = evidence.at(-1).pid;
    check(registry.includes(`kCGSSessionSecureInputPID"=${pid}`), "ioreg does not identify this app as owner");
    evidence.push({ ioreg_secure_owner_pid: pid });
    run("screencapture", ["-x", "-T", "1", join(out, "native-progress-secure.png")]);
  }
  await call("minimize");
  const background = await until(
    () => call("state"),
    (r) => r.minimized && !r.focused && (process.platform !== "darwin" || !r.secure.enabled),
  );
  if (process.platform === "darwin") check(!background.secure.enabled, "Secure input not suspended in background");
  await call("focus");
  const restored = await until(
    () => call("state"),
    (r) => r.focused && !r.minimized && (process.platform !== "darwin" || r.secure.enabled),
  );
  if (process.platform === "darwin") check(restored.secure.enabled, "Secure input not restored with focus");
  const disabled = await call("secure", { enabled: false });
  if (process.platform === "darwin") check(!disabled.secure.enabled, "Last release did not disable");
  await call("secure", { enabled: false });
  for (const state of ["error", "paused", "indeterminate", "none"]) await call("progress", { state, value: 33 });
  if (process.platform === "darwin") run("screencapture", ["-x", "-T", "1", join(out, "native-focus-cleared.png")]);
} finally {
  for (let release = 0; release < 2; release++) {
    try {
      await call("secure", { enabled: false });
    } catch {}
  }
  try {
    await call("progress", { state: "none", value: 0 });
  } catch {}
  await writeFile(join(out, "native-smoke.json"), JSON.stringify(evidence, null, 2) + "\n");
}
console.log("Native smoke passed; the app remains running for inspection.");
