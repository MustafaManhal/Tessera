// Whether an agent typed into a shell pane (`claude`, `codex`) is busy. Typed agents have no status hooks, so the pane
// watches its output: a working agent redraws its spinner and timer many times a second without anyone typing, while
// an agent waiting for the user prints nothing. Output that follows a key press is the echo of that key, not work.

/** Output this soon after a key press is treated as its echo. */
export const ECHO_MS = 300;
/** A pause longer than this breaks a run of output. */
export const GAP_MS = 600;
/** Output must keep coming this long before the agent counts as busy (a redraw after a resize is shorter). */
export const SUSTAIN_MS = 1000;
/** Quiet this long and the agent is no longer busy. */
export const IDLE_MS = 1500;

export interface BusyTracker {
  /** The pane received output. */
  output(): void;
  /** The user typed into the pane. */
  input(): void;
  /** The agent ended or the pane closed: not busy, and stop watching. */
  stop(): void;
}

export interface BusyTrackerOptions {
  onChange: (busy: boolean) => void;
  now?: () => number;
  setTimer?: (run: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export function createBusyTracker(options: BusyTrackerOptions): BusyTracker {
  const now = options.now ?? (() => performance.now());
  const setTimer = options.setTimer ?? ((run, ms) => setTimeout(run, ms));
  const clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  let busy = false;
  let lastInput = Number.NEGATIVE_INFINITY;
  let lastOutput = Number.NEGATIVE_INFINITY;
  let runStart: number | null = null;
  let idle: unknown = null;

  const set = (next: boolean) => {
    if (busy === next) return;
    busy = next;
    options.onChange(next);
  };
  const quiet = () => {
    idle = null;
    runStart = null;
    set(false);
  };

  return {
    output() {
      const at = now();
      if (at - lastInput < ECHO_MS) return;
      if (runStart === null || at - lastOutput > GAP_MS) runStart = at;
      lastOutput = at;
      if (at - runStart >= SUSTAIN_MS) set(true);
      if (idle !== null) clearTimer(idle);
      idle = setTimer(quiet, IDLE_MS);
    },
    input() {
      lastInput = now();
    },
    stop() {
      if (idle !== null) clearTimer(idle);
      idle = null;
      runStart = null;
      set(false);
    },
  };
}
