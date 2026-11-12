import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAgentObserver } from "../../src/agents/observe";
import type { AgentObservation } from "../../src/agents/types";
import type { TerminalEngine } from "@tessera/term";

// The observer's contract (brief 31): screen lines 250 ms after output goes quiet, silence at 5 s, OSC forwarded
// at once, and nothing at all for panes without an agent session.

function fakeEngine(lines: string[]): TerminalEngine {
  return {
    viewportLine: 0,
    bufferLength: lines.length,
    line: (index: number) => ({ text: lines[index] ?? "", wrapped: false }),
  } as unknown as TerminalEngine;
}

function harness(sessionId: string | null = "as_1", lines: string[] = ["line one", "prompt >"]) {
  const sent: { id: string; observation: AgentObservation }[] = [];
  const observer = createAgentObserver({
    engine: () => fakeEngine(lines),
    sessionId: () => sessionId,
    send: (id, observation) => sent.push({ id, observation }),
  });
  return { observer, sent };
}

describe("createAgentObserver", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("sends the last screen lines once output has been quiet for 250 ms", () => {
    const { observer, sent } = harness();
    observer.output();
    observer.output(); // a burst coalesces into one observation
    expect(sent).toEqual([]);
    vi.advanceTimersByTime(250);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.id).toBe("as_1");
    expect(sent[0]?.observation).toEqual({ kind: "screen", lines: ["line one", "prompt >"] });
  });

  it("sends silence once per quiet period, five seconds after the last output", () => {
    const { observer, sent } = harness();
    observer.output();
    vi.advanceTimersByTime(5_000);
    // The screen observation fires at 250 ms; silence lands at 5 s.
    expect(sent.map((s) => s.observation.kind)).toEqual(["screen", "silence"]);
    // Still quiet: no repeat. New output resets the period.
    vi.advanceTimersByTime(10_000);
    expect(sent).toHaveLength(2); // silence + the screen observation at 250 ms
    observer.output();
    vi.advanceTimersByTime(5_000);
    expect(sent.filter((s) => s.observation.kind === "silence")).toHaveLength(2);
  });

  it("forwards OSC observations immediately, without an agent session check delay", () => {
    const { observer, sent } = harness();
    observer.observe({ kind: "osc_notification", text: "needs approval" });
    expect(sent).toEqual([{ id: "as_1", observation: { kind: "osc_notification", text: "needs approval" } }]);
  });

  it("does nothing for a pane without an agent session", () => {
    const { observer, sent } = harness(null);
    observer.output();
    observer.observe({ kind: "osc_notification", text: "hi" });
    vi.advanceTimersByTime(10_000);
    expect(sent).toEqual([]);
  });

  it("stops sending after dispose", () => {
    const { observer, sent } = harness();
    observer.output();
    observer.dispose();
    vi.advanceTimersByTime(10_000);
    expect(sent).toEqual([]);
  });
});
