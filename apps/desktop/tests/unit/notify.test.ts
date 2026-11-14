import { describe, expect, it } from "vitest";
import { activeTabOf, sequentialIds } from "../../src/layout";
import { createRecordingSink } from "../../src/native/notifications";
import { longCommandAlert } from "../../src/notify/alerts";
import { NOTIFY_INTERVAL_MS, NotificationService, type PaneNotice } from "../../src/notify/service";
import { createThrottle } from "../../src/notify/throttle";
import { createAppStore } from "../../src/store";
import { combineProgress, setBadge, setProgress } from "../../src/store/attentionSlice";
import { layout } from "../../src/store/layoutSlice";
import { setTerminal } from "../../src/store/settingsSlice";
import { setWindowFocused } from "../../src/store/uiSlice";

/** A clock and timers the test moves by hand. */
function fakeTime() {
  let now = 0;
  const timers = new Map<number, { at: number; run: () => void }>();
  let next = 1;
  return {
    now: () => now,
    setTimer: (run: () => void, ms: number) => {
      const id = next++;
      timers.set(id, { at: now + ms, run });
      return id;
    },
    clearTimer: (id: unknown) => {
      timers.delete(id as number);
    },
    advance(ms: number) {
      now += ms;
      for (const [id, timer] of [...timers].sort((a, b) => a[1].at - b[1].at)) {
        if (timer.at <= now) {
          timers.delete(id);
          timer.run();
        }
      }
    },
    pending: () => timers.size,
  };
}

describe("throttle", () => {
  it("sends the first at once and folds the rest of the interval into one, per key", () => {
    const time = fakeTime();
    const sent: [string, string, number][] = [];
    const throttle = createThrottle<string>({
      intervalMs: 5000,
      ...time,
      send: (k, item, n) => sent.push([k, item, n]),
    });
    throttle.offer("a", "one");
    throttle.offer("a", "two");
    throttle.offer("a", "three");
    throttle.offer("b", "other");
    expect(sent).toEqual([
      ["a", "one", 1],
      ["b", "other", 1],
    ]);
    time.advance(4999);
    expect(sent).toHaveLength(2);
    time.advance(1);
    expect(sent.at(-1)).toEqual(["a", "three", 2]);
    // The coalesced send starts a new interval.
    throttle.offer("a", "four");
    expect(sent).toHaveLength(3);
    time.advance(5000);
    expect(sent.at(-1)).toEqual(["a", "four", 1]);
    time.advance(5000);
    throttle.offer("a", "five");
    expect(sent.at(-1)).toEqual(["a", "five", 1]);
  });

  it("forgets a key and disposes its timers", () => {
    const time = fakeTime();
    const sent: string[] = [];
    const throttle = createThrottle<string>({ intervalMs: 5000, ...time, send: (_k, item) => sent.push(item) });
    throttle.offer("a", "1");
    throttle.offer("a", "2");
    throttle.forget("a");
    time.advance(6000);
    expect(sent).toEqual(["1"]);
    throttle.offer("b", "1");
    throttle.offer("b", "2");
    throttle.dispose();
    expect(time.pending()).toBe(0);
  });
});

function setup() {
  const store = createAppStore({ env: { newId: sequentialIds("n") } });
  const sink = createRecordingSink();
  const time = fakeTime();
  const toasts: { title: string; description?: string }[] = [];
  let focusedWindow = 0;
  const service = new NotificationService({
    sink,
    getState: store.getState,
    dispatch: store.dispatch,
    focusWindow: () => {
      focusedWindow += 1;
    },
    ...time,
  });
  service.setToaster((options) => toasts.push(options));
  const first = activeTabOf(store.getState().layout)?.focusedPane as string;
  store.dispatch(layout({ type: "pane/setCwd", paneId: first, cwd: "/home/you/shop" }));
  const notice = (paneId: string, body: string, extra: Partial<PaneNotice> = {}): PaneNotice => ({
    paneId,
    title: "",
    body,
    badge: "notification",
    source: "program",
    ...extra,
  });
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
  return { store, sink, time, toasts, service, first, notice, flush, windowFocus: () => focusedWindow };
}

describe("NotificationService", () => {
  it("shows a toast, not an OS notification, for the pane being looked at", async () => {
    const { service, sink, toasts, first, notice, flush, store } = setup();
    service.notify(notice(first, "hello"));
    await flush();
    expect(sink.shown).toHaveLength(0);
    expect(toasts).toEqual([{ title: "shop", description: "hello" }]);
    expect(store.getState().attention.badges[first]).toBeUndefined();
    // kitty o=unfocused: nothing at all while looked at.
    service.notify(notice(first, "quiet", { occasion: "unfocused" }));
    await flush();
    expect(toasts).toHaveLength(1);
  });

  it("shows an OS notification with the pane title as the source when the window is not focused", async () => {
    const { service, sink, first, notice, flush, store } = setup();
    store.dispatch(setWindowFocused(false));
    service.notify(notice(first, "All green", { title: "Build done" }));
    await flush();
    expect(sink.shown).toEqual([{ paneId: first, title: "Build done · shop", body: "All green" }]);
    expect(store.getState().attention.badges[first]).toEqual({ kind: "notification", text: "All green" });
  });

  it("notifies for a pane in another tab even while the window is focused", async () => {
    const { service, sink, first, notice, flush, store } = setup();
    store.dispatch(layout({ type: "tab/new" }));
    service.notify(notice(first, "background"));
    await flush();
    expect(sink.shown).toHaveLength(1);
  });

  it("rate-limits to one per pane per 5 s and folds the rest", async () => {
    const { service, sink, first, notice, flush, store, time } = setup();
    store.dispatch(setWindowFocused(false));
    for (let i = 1; i <= 4; i++) service.notify(notice(first, `n${i}`));
    await flush();
    expect(sink.shown.map((shown) => shown.body)).toEqual(["n1"]);
    time.advance(NOTIFY_INTERVAL_MS);
    await flush();
    expect(sink.shown.map((shown) => shown.body)).toEqual(["n1", "n4 (and 2 more)"]);
  });

  it("follows notifications.enabled for programs but not for long-command alerts", async () => {
    const { service, sink, first, notice, flush, store } = setup();
    store.dispatch(setWindowFocused(false));
    store.dispatch(setTerminal({ notifications: false }));
    service.notify(notice(first, "program"));
    service.notify(notice(first, "long", { source: "longCommand", badge: "finished" }));
    await flush();
    expect(sink.shown.map((shown) => shown.body)).toEqual(["long"]);
  });

  it("asks with the explanation first when the permission is undecided, then shows what waited", async () => {
    const { service, sink, first, notice, flush, store } = setup();
    sink.permissionState = "default";
    store.dispatch(setWindowFocused(false));
    service.notify(notice(first, "waiting"));
    await flush();
    expect(store.getState().ui.notificationPrompt).toBe(true);
    expect(sink.shown).toHaveLength(0);
    await service.answerPrompt(true);
    expect(sink.requests).toBe(1);
    expect(store.getState().ui.notificationPrompt).toBe(false);
    expect(sink.shown.map((shown) => shown.body)).toEqual(["waiting"]);
  });

  it("keeps notifications in the app after Not now or a denied permission", async () => {
    const { service, sink, first, notice, flush, store, toasts, time } = setup();
    sink.permissionState = "default";
    store.dispatch(setWindowFocused(false));
    service.notify(notice(first, "one"));
    await flush();
    await service.answerPrompt(false);
    expect(sink.requests).toBe(0);
    expect(toasts.map((toast) => toast.description)).toEqual(["one"]);
    time.advance(NOTIFY_INTERVAL_MS);
    service.notify(notice(first, "two"));
    await flush();
    expect(store.getState().ui.notificationPrompt).toBe(false);
    expect(toasts.map((toast) => toast.description)).toEqual(["one", "two"]);
  });

  it("focuses the pane (its tab, the pane, the window) when a notification is clicked", async () => {
    const { service, sink, first, notice, flush, store, windowFocus } = setup();
    store.dispatch(layout({ type: "tab/new" }));
    service.notify(notice(first, "click me"));
    await flush();
    sink.click(0);
    await flush();
    const state = store.getState();
    expect(activeTabOf(state.layout)?.focusedPane).toBe(first);
    expect(windowFocus()).toBe(1);
    expect(state.ui.paneFocusRequest).toBeGreaterThan(0);
  });

  it("drops notices for panes that do not exist", async () => {
    const { service, sink, notice, flush, store } = setup();
    store.dispatch(setWindowFocused(false));
    service.notify(notice("missing", "x"));
    await flush();
    expect(sink.shown).toHaveLength(0);
  });
});

describe("attention slice", () => {
  it("clears a badge once the pane is looked at again, and forgets closed panes", () => {
    const { store, first } = setup();
    store.dispatch(setWindowFocused(false));
    store.dispatch(setBadge({ paneId: first, badge: { kind: "finished", text: "done" } }));
    store.dispatch(setProgress({ paneId: first, progress: { state: "normal", value: 10 } }));
    expect(store.getState().attention.badges[first]).toBeDefined();
    store.dispatch(setWindowFocused(true));
    expect(store.getState().attention.badges[first]).toBeUndefined();
    store.dispatch(layout({ type: "pane/split", direction: "right" }));
    store.dispatch(layout({ type: "pane/close", paneId: first }));
    expect(store.getState().attention.progress[first]).toBeUndefined();
  });

  it("keeps the last value for error and paused without one, and a failure over a notification", () => {
    const { store, first } = setup();
    store.dispatch(setProgress({ paneId: first, progress: { state: "normal", value: 40 } }));
    store.dispatch(setProgress({ paneId: first, progress: { state: "paused", value: null } }));
    expect(store.getState().attention.progress[first]).toEqual({ state: "paused", value: 40 });
    store.dispatch(setProgress({ paneId: first, progress: { state: "indeterminate", value: 5 } }));
    expect(store.getState().attention.progress[first]).toEqual({ state: "indeterminate", value: null });
    store.dispatch(setWindowFocused(false));
    store.dispatch(setBadge({ paneId: first, badge: { kind: "failed", text: "x" } }));
    store.dispatch(setBadge({ paneId: first, badge: { kind: "notification", text: "y" } }));
    expect(store.getState().attention.badges[first]?.kind).toBe("failed");
  });

  it("combines progress: error, then paused, then the slowest", () => {
    expect(combineProgress([])).toBeNull();
    expect(
      combineProgress([
        { state: "normal", value: 80 },
        { state: "normal", value: 20 },
        { state: "indeterminate", value: null },
      ]),
    ).toEqual({ state: "normal", value: 20 });
    expect(
      combineProgress([
        { state: "paused", value: 50 },
        { state: "error", value: 10 },
      ]),
    ).toEqual({ state: "error", value: 10 });
  });
});

describe("long-command alert", () => {
  const block = (startedAt: number, endedAt: number, extra = {}) => ({
    id: 1,
    command: "npm test",
    startedAt,
    endedAt,
    exitCode: 0,
    status: "success" as const,
    ...extra,
  });
  const base = {
    enabled: true,
    thresholdSeconds: 30,
    paneFocused: false,
    windowFocused: true,
    alerted: new Set<number>(),
  };

  it("alerts for a long block that ends while the pane is not looked at", () => {
    expect(longCommandAlert({ ...base, block: block(0, 72_000) })).toEqual({
      body: "npm test finished in 1m 12s, exit 0",
      badge: "finished",
    });
    expect(
      longCommandAlert({
        ...base,
        paneFocused: true,
        windowFocused: false,
        block: block(0, 31_000, { exitCode: 1, status: "failure" }),
      }),
    ).toEqual({ body: "npm test finished in 31s, exit 1", badge: "failed" });
  });

  it("never alerts when looked at, when short, when off, when aborted, or twice", () => {
    expect(longCommandAlert({ ...base, paneFocused: true, block: block(0, 60_000) })).toBeNull();
    expect(longCommandAlert({ ...base, block: block(0, 30_000) })).toBeNull();
    expect(longCommandAlert({ ...base, enabled: false, block: block(0, 60_000) })).toBeNull();
    expect(longCommandAlert({ ...base, block: block(0, 60_000, { status: "aborted" }) })).toBeNull();
    expect(longCommandAlert({ ...base, alerted: new Set([1]), block: block(0, 60_000) })).toBeNull();
    expect(longCommandAlert({ ...base, block: { ...block(0, 60_000), endedAt: null } })).toBeNull();
  });

  it("measures from the block's start: one that began while the window was unfocused needs the full threshold", () => {
    // The window lost the focus at t=0; the block began at t=50 s and ended 10 s later.
    expect(longCommandAlert({ ...base, windowFocused: false, block: block(50_000, 60_000) })).toBeNull();
    expect(longCommandAlert({ ...base, windowFocused: false, block: block(50_000, 90_000) })).not.toBeNull();
  });

  it("names unnamed and long commands readably", () => {
    expect(longCommandAlert({ ...base, block: block(0, 40_000, { command: null }) })?.body).toBe(
      "A command finished in 40s, exit 0",
    );
    const long = longCommandAlert({ ...base, block: block(0, 40_000, { command: `make ${"x".repeat(100)}` }) });
    expect(long?.body.startsWith("make xxx")).toBe(true);
    expect(long?.body).toContain("…");
    expect(longCommandAlert({ ...base, block: block(0, 40_000, { command: "a \\\n  b" }) })?.body).toContain("a \\ b");
  });
});
