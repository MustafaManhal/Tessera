import { describe, expect, it } from "vitest";
import { createCommandTracker, parseOsc7, UNNAMED_COMMAND } from "../../src/terminal/osc";
import { initialSession, liveSession, type SessionState, sessionReducer } from "../../src/terminal/session";

describe("session state machine", () => {
  const run = (...events: Parameters<typeof sessionReducer>[1][]) =>
    events.reduce<SessionState>((state, event) => sessionReducer(state, event), initialSession);

  it("starts, runs, exits and restarts with a new generation", () => {
    const running = run({ type: "started", generation: 1, sessionId: "s1" });
    expect(running).toEqual({ status: "running", generation: 1, sessionId: "s1" });
    expect(liveSession(running)).toBe("s1");
    const exited = sessionReducer(running, { type: "exited", generation: 1, code: 2 });
    expect(exited).toEqual({ status: "exited", generation: 1, code: 2 });
    expect(liveSession(exited)).toBeNull();
    expect(sessionReducer(exited, { type: "restart" })).toEqual({ status: "starting", generation: 2 });
  });

  it("fails to start, and restarts from the failure", () => {
    const failed = run({ type: "failed", generation: 1, message: "No such folder" });
    expect(failed).toMatchObject({ status: "failed", message: "No such folder" });
    expect(sessionReducer(failed, { type: "restart" }).status).toBe("starting");
  });

  it("ignores events from an older generation and restarts while running", () => {
    const restarted = run(
      { type: "started", generation: 1, sessionId: "s1" },
      { type: "exited", generation: 1, code: 0 },
      { type: "restart" },
    );
    expect(sessionReducer(restarted, { type: "started", generation: 1, sessionId: "old" })).toBe(restarted);
    const running = sessionReducer(restarted, { type: "started", generation: 2, sessionId: "s2" });
    expect(sessionReducer(running, { type: "restart" })).toBe(running);
    expect(sessionReducer(running, { type: "failed", generation: 2, message: "late" })).toBe(running);
  });
});

describe("parseOsc7", () => {
  it("reads the path of a file:// URL, decoded", () => {
    expect(parseOsc7("file://mac.local/Users/me/shop%20api")).toBe("/Users/me/shop api");
    expect(parseOsc7("file:///tmp")).toBe("/tmp");
    expect(parseOsc7("file://pc/C:/Users/me")).toBe("C:/Users/me");
  });

  it("rejects anything else", () => {
    expect(parseOsc7("https://example.com/x")).toBeNull();
    expect(parseOsc7("file://hostonly")).toBeNull();
    expect(parseOsc7("file://h/%E0%A4%A")).toBeNull();
  });
});

describe("command tracker (OSC 133 / 633)", () => {
  it("names the running command from 633;E and clears it on 133;D", () => {
    const tracker = createCommandTracker();
    tracker.osc633("E;npm run dev");
    expect(tracker.osc133("C")).toBe("npm run dev");
    expect(tracker.running).toBe("npm run dev");
    expect(tracker.osc133("D;130")).toBeNull();
    expect(tracker.running).toBeNull();
  });

  it("uses a generic name without 633, and reports no change when nothing changed", () => {
    const tracker = createCommandTracker();
    expect(tracker.osc133("A")).toBeUndefined();
    expect(tracker.osc133("B")).toBeUndefined();
    expect(tracker.osc133("C")).toBe(UNNAMED_COMMAND);
    expect(tracker.osc133("C")).toBeUndefined();
    expect(tracker.osc133("D;0")).toBeNull();
    expect(tracker.osc133("D;0")).toBeUndefined();
  });

  it("a new prompt (133;A) also ends a command whose D was lost", () => {
    const tracker = createCommandTracker();
    tracker.osc633("E;sleep 9");
    tracker.osc133("C");
    expect(tracker.osc133("A")).toBeNull();
  });
});
