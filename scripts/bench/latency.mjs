/** Host-only round trips; key-to-glyph rendering is measured separately in the UI. */
import { cargo, metadata, save } from "./common.mjs";
console.log(metadata());
const output = cargo(["run", "--release", "-p", "tessera-pty", "--example", "latency"]);

cargo([
  "test",
  "--release",
  "-p",
  "tessera-pty",
  "--test",
  "performance",
  "latency_meets_budget",
  "--",
  "--ignored",
  "--nocapture",
]);
// NFR-13: the focused pane keeps its latency with 50 open sessions, 20 of them busy like running agents.
const scale = cargo([
  "test",
  "--release",
  "-p",
  "tessera-pty",
  "--test",
  "performance",
  "latency_holds_with_twenty_busy_agents_and_fifty_sessions",
  "--",
  "--ignored",
  "--nocapture",
]);
await save("Host latency", {
  output: output.trim(),
  under_load: scale.split("\n").find((line) => line.startsWith("under load")),
});
