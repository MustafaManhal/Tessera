import { afterEach, describe, expect, it, vi } from "vitest";
import { actions, primaryShortcut } from "../../src/actions/registry";
import { keymap } from "../../src/actions/keymap";
import {
  FakeMenuClient,
  NativeMenuClient,
  nativeMenuItems,
  startNativeMenu,
  type NativeMenuItem,
} from "../../src/native/menu";

afterEach(() => {
  keymap.setOverrides({}, {}, "mac");
});

describe("native menu adapter", () => {
  it.each(["mac", "windows"] as const)("uses the registry shortcut for every %s menu accelerator", (platform) => {
    const items = nativeMenuItems(platform);

    expect(items).toEqual(
      actions.flatMap((action) => {
        const accelerator = primaryShortcut(action.id, platform);
        return accelerator ? [{ id: action.id, label: expect.any(String), accelerator, group: action.group }] : [];
      }),
    );
  });

  it.each(["mac", "windows"] as const)("refreshes %s menu shortcuts after user keybinding changes", (platform) => {
    const client = new FakeMenuClient();
    const stop = startNativeMenu(client, platform, () => true);
    const initialCount = client.setCount;

    keymap.setOverrides({ "tab.new": "Mod+Alt+9" }, {}, platform);

    expect(client.setCount).toBe(initialCount + 1);
    expect(client.items.find((item) => item.id === "tab.new")?.accelerator).toBe(primaryShortcut("tab.new", platform));

    stop();
  });

  it("routes menu actions by id and stops listening when disposed", async () => {
    const client = new FakeMenuClient();
    const executeAction = vi.fn(() => true);
    const stop = startNativeMenu(client, "mac", executeAction);
    client.emitAction("tab.new");
    expect(executeAction).toHaveBeenCalledWith("tab.new");

    await Promise.resolve();
    stop();
    const stoppedCount = client.setCount;
    keymap.setOverrides({ "tab.new": "Mod+Alt+8" }, {}, "mac");
    client.emitAction("tab.close");
    expect(client.setCount).toBe(stoppedCount);
    expect(executeAction).toHaveBeenCalledOnce();
  });

  it("adapts the planned menu bindings shape", async () => {
    const items: NativeMenuItem[] = [{ id: "tab.new", label: "New tab", accelerator: "Mod+T", group: "tabs" }];
    const menuSet = vi.fn(async (_items: NativeMenuItem[]) => {});
    const onMenuAction = vi.fn(async (_listener: (id: string) => void) => () => {});
    const client = new NativeMenuClient({ menuSet, onMenuAction });
    const action = vi.fn();

    await client.setItems(items);
    await client.onAction(action);

    expect(menuSet).toHaveBeenCalledWith(items);
    expect(onMenuAction).toHaveBeenCalledWith(action);
  });
});
