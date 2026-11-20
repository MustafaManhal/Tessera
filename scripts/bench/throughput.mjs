/** pnpm bench:throughput: release host + UI-ack simulation + ignored NFR-02 gate. */
import { cargo, metadata, save } from "./common.mjs";
import { parseThroughput } from "../lib/bench.mjs";
console.log(metadata());
let result = {};
let pass = false;
try {
  result = parseThroughput(cargo(["run", "--release", "-p", "tessera-pty", "--example", "throughput"]));
  cargo([
    "test",
    "--release",
    "-p",
    "tessera-pty",
    "--test",
    "performance",
    "throughput_meets_nfr02",
    "--",
    "--ignored",
    "--nocapture",
  ]);
  // NFR-02: 100 MiB in 5 s on macOS; Windows 40 s (D-16: ConPTY renders everything it carries, measured ~9 MiB/s).
  const limit = process.platform === "win32" ? 40 : 5;
  pass = result.seconds <= limit && result.mibps >= 100 / limit;
} catch (error) {
  result.error = error.message;
}
const outcome = { ...result, nfr: "NFR-02 host, immediate ack; UI responsiveness unmeasured", pass };
console.log(JSON.stringify(outcome));
await save("Throughput", outcome);
if (!pass) process.exitCode = 1;
