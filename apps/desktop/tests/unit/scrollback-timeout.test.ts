import { afterEach, describe, expect, it, vi } from "vitest";
import { createLayoutStore, restoreScrollback, SCROLLBACK_LOAD_TIMEOUT_MS } from "../../src/restore/service";

describe("restoreScrollback", () => {
  afterEach(() => vi.useRealTimers());

  it("starts without the old history, not with an error, when the load is too slow", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    createLayoutStore({
      layoutSave: async () => {},
      layoutLoad: async () => [],
      scrollbackLoad: () => new Promise(() => {}),
    });
    const pending = restoreScrollback("pane-1");
    await vi.advanceTimersByTimeAsync(SCROLLBACK_LOAD_TIMEOUT_MS + 1);
    await expect(pending).resolves.toBeNull();
  });

  it("returns the saved bytes when they arrive in time", async () => {
    createLayoutStore({
      layoutSave: async () => {},
      layoutLoad: async () => [],
      scrollbackLoad: async () => [104, 105],
    });
    expect(Array.from((await restoreScrollback("pane-2")) ?? [])).toEqual([104, 105]);
  });
});
