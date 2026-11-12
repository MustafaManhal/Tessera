import { describe, expect, it } from "vitest";
import {
  percentile,
  parseThroughput,
  parseProcesses,
  processTree,
  parseEvents,
  coldStartBreakdown,
  withoutShells,
} from "./bench.mjs";
describe("benchmark parsing and maths", () => {
  it("uses nearest rank without mutating input", () => {
    const values = [4, 1, 3, 2];
    expect(percentile(values, 0.5)).toBe(2);
    expect(percentile(values, 0.95)).toBe(4);
    expect(values).toEqual([4, 1, 3, 2]);
    expect(() => percentile([], 0.5)).toThrow();
    expect(() => percentile([1], 2)).toThrow();
    expect(() => percentile([NaN], 0.5)).toThrow();
  });
  it("requires a full successful throughput run", () => {
    expect(parseThroughput("104883200 bytes in 2.00 s: 50.01 MiB/s (exit 0)").mibps).toBe(50.01);
    expect(() => parseThroughput("10 bytes in 2.00 s: 0.01 MiB/s (exit 0)")).toThrow();
    expect(() => parseThroughput("104883200 bytes in 2.00 s: 50.01 MiB/s (exit 1)")).toThrow();
  });
  it("finds descendants across out-of-order rows without including siblings", () => {
    const rows = parseProcesses("3 2 10\n1 0 20\n2 1 30\n4 0 40");
    expect(processTree(rows, 1).map((r) => r.pid)).toEqual([3, 1, 2]);
    expect(processTree(rows, 1).reduce((sum, r) => sum + r.bytes, 0)).toBe(60 * 1024);
    expect(parseProcesses('{"ProcessId":1,"ParentProcessId":0,"WorkingSetSize":1024}', true)[0].bytes).toBe(1024);
    expect(() => parseProcesses("bad row")).toThrow();
  });
  it("does not consume a partial telemetry write", () => {
    expect(parseEvents('{"event":"window"}\n{"event":')).toEqual([{ event: "window" }]);
  });
});

it("attributes startup using exec marks and refuses missing or reversed events", () => {
  const events = Object.entries({
    run_entry: 10,
    setup_begin: 20,
    pty_spawn: 100,
    shell_started: 120,
    host_spawn_complete: 121,
    first_byte: 350,
    first_output: 351,
    prompt_read: 390,
    prompt: 400,
  }).map(([event, ms]) => ({ event, ms }));
  expect(coldStartBreakdown(events)).toMatchObject({
    launch_to_prompt_ms: 400,
    our_to_shell_ms: 120,
    shell_to_prompt_ms: 270,
    delivery_ms: 10,
    our_total_ms: 131,
    post_spawn_host_ms: 1,
  });
  expect(() => coldStartBreakdown(events.slice(1))).toThrow();
  expect(() => coldStartBreakdown(events.map((e) => (e.event === "prompt_read" ? { ...e, ms: 500 } : e)))).toThrow();
  expect(() => coldStartBreakdown(events.map((e) => (e.event === "prompt" ? { ...e, ms: 90 } : e)))).toThrow();
});

describe("memory without the user's shells", () => {
  it("drops shells and everything below them, keeps the app and its webview", () => {
    const rows = parseProcesses(
      [
        "10 1 100000 /Applications/Tessera.app/Contents/MacOS/tessera-desktop",
        "11 10 50000 com.apple.WebKit.WebContent",
        "12 10 6000 zsh",
        "13 12 9000 node",
        "14 10 7000 -zsh",
      ].join("\n"),
    );
    expect(withoutShells(rows).map((r) => r.pid)).toEqual([10, 11]);
    const win = parseProcesses(
      JSON.stringify([
        { ProcessId: 1, ParentProcessId: 0, WorkingSetSize: 10, Name: "tessera-desktop" },
        { ProcessId: 2, ParentProcessId: 1, WorkingSetSize: 20, Name: "msedgewebview2" },
        { ProcessId: 3, ParentProcessId: 1, WorkingSetSize: 90, Name: "powershell" },
        { ProcessId: 4, ParentProcessId: 3, WorkingSetSize: 30, Name: "conhost" },
        { ProcessId: 5, ParentProcessId: 1, WorkingSetSize: 5, Name: "OpenConsole" },
      ]),
      true,
    );
    expect(withoutShells(win).map((r) => r.pid)).toEqual([1, 2]);
    // Rows without a name are kept: nothing is dropped on a guess.
    expect(withoutShells(parseProcesses("1 0 10\n2 1 20")).length).toBe(2);
  });
});
