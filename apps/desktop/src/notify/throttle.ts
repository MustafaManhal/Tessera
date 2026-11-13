// Rate limit with coalescing (UI-UX §1, attention rules): at most one notification per key (a pane) per interval.
// The first goes out at once; the ones that come during the interval are folded into one, sent when it ends, with
// the latest text and how many it stands for. Pure apart from the injected clock and timer.

export interface ThrottleOptions<T> {
  intervalMs: number;
  now: () => number;
  setTimer: (run: () => void, ms: number) => unknown;
  clearTimer: (handle: unknown) => void;
  /** `count` is how many offers this one send stands for (1 when nothing was folded in). */
  send: (key: string, item: T, count: number) => void;
}

interface KeyState<T> {
  last: number;
  pending: T | null;
  count: number;
  timer: unknown;
}

export interface Throttle<T> {
  offer(key: string, item: T): void;
  /** Drops what is waiting for a key (the pane closed). */
  forget(key: string): void;
  dispose(): void;
}

export function createThrottle<T>(options: ThrottleOptions<T>): Throttle<T> {
  const keys = new Map<string, KeyState<T>>();

  const flush = (key: string) => {
    const state = keys.get(key);
    if (!state) return;
    state.timer = null;
    if (state.pending === null) return;
    const item = state.pending;
    const count = state.count;
    state.pending = null;
    state.count = 0;
    state.last = options.now();
    options.send(key, item, count);
  };

  return {
    offer(key, item) {
      const now = options.now();
      const state = keys.get(key);
      if (!state || now - state.last >= options.intervalMs) {
        if (state?.timer) options.clearTimer(state.timer);
        keys.set(key, { last: now, pending: null, count: 0, timer: null });
        options.send(key, item, 1);
        return;
      }
      state.pending = item;
      state.count += 1;
      if (!state.timer) state.timer = options.setTimer(() => flush(key), state.last + options.intervalMs - now);
    },
    forget(key) {
      const state = keys.get(key);
      if (state?.timer) options.clearTimer(state.timer);
      keys.delete(key);
    },
    dispose() {
      for (const state of keys.values()) if (state.timer) options.clearTimer(state.timer);
      keys.clear();
    },
  };
}
