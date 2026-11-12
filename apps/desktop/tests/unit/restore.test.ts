import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sequentialIds, serializeLayout } from "../../src/layout";
import { AUTOSAVE_DELAY_MS, restoreLayout, startAutosave, type RestoreOutcome } from "../../src/restore/persist";
import { FakeLayoutStore } from "../../src/restore/store";
import { consumeRestored, markRestored } from "../../src/restore/restored";
import { createAppStore } from "../../src/store";
import { layout } from "../../src/store/layoutSlice";

const fresh = () => createAppStore({ env: { newId: sequentialIds("n") } });

describe("autosave", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("saves 500 ms after the last layout change, not sooner", async () => {
    const store = fresh();
    const layoutStore = new FakeLayoutStore();
    const autosave = startAutosave({ store, layoutStore });
    store.dispatch(layout({ type: "tab/new" }));
    expect(layoutStore.saves).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS - 1);
    expect(layoutStore.saves).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(layoutStore.saves).toHaveLength(1);
    expect(layoutStore.saves[0]?.state.tabs).toHaveLength(2);
    autosave.stop();
  });

  it("resets the debounce when another change arrives", async () => {
    const store = fresh();
    const layoutStore = new FakeLayoutStore();
    const autosave = startAutosave({ store, layoutStore });
    store.dispatch(layout({ type: "tab/new" }));
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS - 50);
    store.dispatch(layout({ type: "tab/new" }));
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS - 1);
    expect(layoutStore.saves).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(layoutStore.saves).toHaveLength(1);
    expect(layoutStore.saves[0]?.state.tabs).toHaveLength(3);
    autosave.stop();
  });

  it("flush saves at once; a second flush with no change does nothing", () => {
    const store = fresh();
    const layoutStore = new FakeLayoutStore();
    const autosave = startAutosave({ store, layoutStore });
    store.dispatch(layout({ type: "pane/split", direction: "right" }));
    autosave.flush();
    expect(layoutStore.saves).toHaveLength(1);
    autosave.flush();
    expect(layoutStore.saves).toHaveLength(1);
    autosave.stop();
  });
});

describe("restoreLayout", () => {
  it("returns off when the setting is disabled", async () => {
    const store = fresh();
    const layoutStore = new FakeLayoutStore();
    await layoutStore.save("main", serializeLayout(store.getState().layout), null);
    const outcome = await restoreLayout({ store, layoutStore, enabled: false });
    expect(outcome).toEqual({ kind: "off" } satisfies RestoreOutcome);
    expect(store.getState().layout.tabs).toHaveLength(1);
  });

  it("returns none when nothing is saved", async () => {
    const store = fresh();
    const outcome = await restoreLayout({ store, layoutStore: new FakeLayoutStore(), enabled: true });
    expect(outcome).toEqual({ kind: "none" });
  });

  it("restores only the layout matching this native window id", async () => {
    const main = fresh();
    const secondary = fresh();
    secondary.dispatch(layout({ type: "tab/new" }));
    const saved = new FakeLayoutStore();
    await saved.save("main", serializeLayout(main.getState().layout), null);
    await saved.save("window-2", serializeLayout(secondary.getState().layout), null);

    const target = fresh();
    const outcome = await restoreLayout({ store: target, layoutStore: saved, enabled: true, windowId: "window-2" });
    expect(outcome).toMatchObject({ kind: "restored", tabs: 2 });
    expect(target.getState().layout.tabs).toHaveLength(2);
  });

  it("treats a new native window's empty placeholder layout as a fresh start", async () => {
    const saved = Object.assign(new FakeLayoutStore(), {
      load: async () => [{ window_id: "window-2", state: "{}", bounds: null, updated_at: 0 }],
    });
    const outcome = await restoreLayout({ store: fresh(), layoutStore: saved, enabled: true, windowId: "window-2" });
    expect(outcome).toEqual({ kind: "none" });
  });

  it("replaces the layout and marks panes as restored", async () => {
    const source = fresh();
    source.dispatch(layout({ type: "tab/new" }));
    source.dispatch(layout({ type: "pane/split", direction: "right" }));
    const saved = serializeLayout(source.getState().layout);
    const layoutStore = new FakeLayoutStore();
    await layoutStore.save("main", saved, null);

    const store = fresh();
    const outcome = await restoreLayout({ store, layoutStore, enabled: true });
    expect(outcome.kind).toBe("restored");
    if (outcome.kind !== "restored") return;
    expect(outcome.tabs).toBe(2);
    expect(store.getState().layout.tabs).toHaveLength(2);
    const paneId = store.getState().layout.tabs[0]?.focusedPane;
    expect(paneId && consumeRestored(paneId)).toBe(true);
    expect(paneId && consumeRestored(paneId)).toBe(false);
  });

  it("repairs a missing focused pane and still restores", async () => {
    const json = serializeLayout(fresh().getState().layout);
    const tab = json.tabs[0];
    expect(tab).toBeDefined();
    if (!tab) return;
    tab.focused_pane = "missing";
    const layoutStore = new FakeLayoutStore();
    await layoutStore.save("main", json, null);
    const store = fresh();
    const outcome = await restoreLayout({ store, layoutStore, enabled: true });
    expect(outcome.kind).toBe("restored");
    if (outcome.kind !== "restored") return;
    expect(outcome.repairs.some((line) => line.includes("focused pane"))).toBe(true);
    expect(store.getState().layout.tabs[0]?.focusedPane).toBeTruthy();
  });

  it("fails on corrupt JSON without touching the store layout", async () => {
    const broken = Object.assign(new FakeLayoutStore(), {
      load: async () => [{ window_id: "main", state: "{nope", bounds: null, updated_at: 0 }],
    });
    const store = fresh();
    const before = store.getState().layout;
    const outcome = await restoreLayout({ store, layoutStore: broken, enabled: true });
    expect(outcome.kind).toBe("failed");
    expect(store.getState().layout).toBe(before);
  });

  it("fails on a newer layout version", async () => {
    const json = serializeLayout(fresh().getState().layout);
    (json as { version: number }).version = 999;
    const layoutStore = new FakeLayoutStore();
    await layoutStore.save("main", json, null);
    const store = fresh();
    const outcome = await restoreLayout({ store, layoutStore, enabled: true });
    expect(outcome.kind).toBe("failed");
  });

  it("times out a hung load", async () => {
    vi.useFakeTimers();
    try {
      const hung: FakeLayoutStore = Object.assign(new FakeLayoutStore(), {
        load: () => new Promise<never>(() => {}),
      });
      const store = fresh();
      const pending = restoreLayout({ store, layoutStore: hung, enabled: true, timeoutMs: 50 });
      await vi.advanceTimersByTimeAsync(50);
      await expect(pending).resolves.toEqual({ kind: "failed", reason: "timed out" });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("restored markers", () => {
  it("consumeRestored is once-only per pane", () => {
    markRestored(["a", "b"]);
    expect(consumeRestored("a")).toBe(true);
    expect(consumeRestored("a")).toBe(false);
    expect(consumeRestored("b")).toBe(true);
    expect(consumeRestored("missing")).toBe(false);
  });
});
