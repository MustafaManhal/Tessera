import { afterEach, describe, expect, it, vi } from "vitest";
import { sequentialIds, serializeLayout } from "../../src/layout";
import { createLayoutStore, restoreScrollback } from "../../src/restore/service";
import { FakeLayoutStore, TauriLayoutStore, type LayoutBindings, type WindowBounds } from "../../src/restore/store";
import { createAppStore } from "../../src/store";

afterEach(() => {
  createLayoutStore();
});

describe("layout store adapters", () => {
  it("uses the fake store by default and serializes opaque layout JSON for the planned bindings", async () => {
    expect(createLayoutStore()).toBeInstanceOf(FakeLayoutStore);
    const layoutLoad = vi.fn(async () => [{ window_id: "main", state: '{"version":1}', bounds: null, updated_at: 4 }]);
    const layoutSave = vi.fn(async (_windowId: string, _state: string, _bounds: WindowBounds | null) => {});
    const scrollbackLoad = vi.fn(async (_paneId: string) => [0x6f, 0x6b]);
    const bindings: LayoutBindings = { layoutSave, layoutLoad, scrollbackLoad };
    const store = createLayoutStore(bindings);
    expect(store).toBeInstanceOf(TauriLayoutStore);

    const state = serializeLayout(createAppStore({ env: { newId: sequentialIds("layout") } }).getState().layout);
    await store.save("main", state, null);
    expect(layoutSave).toHaveBeenCalledWith("main", JSON.stringify(state), null);
    await expect(store.load()).resolves.toEqual([
      { window_id: "main", state: '{"version":1}', bounds: null, updated_at: 4 },
    ]);
    await expect(restoreScrollback("pane-1")).resolves.toEqual(Uint8Array.of(0x6f, 0x6b));
    expect(scrollbackLoad).toHaveBeenCalledWith("pane-1");
  });

  it("returns no scrollback for an empty byte vector and propagates binding errors", async () => {
    const bindings: LayoutBindings = {
      layoutSave: async () => {
        throw new Error("disk full");
      },
      layoutLoad: async () => [],
      scrollbackLoad: async () => [],
    };
    const store = new TauriLayoutStore(bindings);
    await expect(store.loadScrollback("pane-1")).resolves.toBeNull();
    await expect(store.save("main", serializeLayout(createAppStore().getState().layout), null)).rejects.toThrow(
      "disk full",
    );
  });
});
