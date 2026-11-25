import { describe, expect, it } from "vitest";
import { createBusyTracker, ECHO_MS, IDLE_MS } from "../../src/terminal/agentBusy";

function harness() {
  let now = 0;
  const changes: boolean[] = [];
  const timers = new Map<number, { at: number; run: () => void }>();
  let next = 1;
  const tracker = createBusyTracker({
    onChange: (busy) => changes.push(busy),
    now: () => now,
    setTimer: (run, ms) => {
      const id = next++;
      timers.set(id, { at: now + ms, run });
      return id;
    },
    clearTimer: (handle) => timers.delete(handle as number),
  });
  const advance = (ms: number) => {
    now += ms;
    for (const [id, timer] of [...timers]) {
      if (timer.at <= now) {
        timers.delete(id);
        timer.run();
      }
    }
  };
  return { tracker, changes, advance };
}

describe("typed agent busy tracker", () => {
  it("turns busy after a second of steady output and idle after it goes quiet", () => {
    const { tracker, changes, advance } = harness();
    for (let i = 0; i < 8; i++) {
      tracker.output();
      advance(100);
    }
    expect(changes).toEqual([]);
    for (let i = 0; i < 4; i++) {
      tracker.output();
      advance(100);
    }
    expect(changes).toEqual([true]);
    advance(IDLE_MS);
    expect(changes).toEqual([true, false]);
  });

  it("ignores the echo of keys the user types", () => {
    const { tracker, changes, advance } = harness();
    for (let i = 0; i < 30; i++) {
      tracker.input();
      advance(ECHO_MS / 3);
      tracker.output();
      advance(50);
    }
    expect(changes).toEqual([]);
  });

  it("a short redraw does not count, and stop clears a busy pane", () => {
    const { tracker, changes, advance } = harness();
    tracker.output();
    advance(200);
    tracker.output();
    advance(IDLE_MS);
    expect(changes).toEqual([]);
    for (let i = 0; i < 15; i++) {
      tracker.output();
      advance(100);
    }
    tracker.stop();
    expect(changes).toEqual([true, false]);
  });
});
