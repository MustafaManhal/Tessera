import { afterEach, describe, expect, it, vi } from "vitest";
import {
  insertTransferredTab,
  removeTransferredTab,
  setWindowClient,
  subscribeToTransferredTabs,
  tabTransferJson,
  transferTab,
  undoTabTransfer,
  type WindowClient,
} from "../../src/native/windows";
import { paneIds, sequentialIds, serializeLayout } from "../../src/layout";
import { createAppStore } from "../../src/store";
import { layout } from "../../src/store/layoutSlice";
import { registerPaneTerminal, type PaneTerminal } from "../../src/terminal/panes";
import { consumeTransferDetach, transferReadiness } from "../../src/terminal/transferState";

let restoreClient: (() => void) | null = null;

afterEach(() => {
  restoreClient?.();
  restoreClient = null;
});

function fakeWindowClient(overrides: Partial<WindowClient> = {}): WindowClient {
  return {
    currentId: async () => "main",
    create: async () => "window-1",
    list: async () => [{ id: "main", title: "Main", focused: true }],
    close: async () => {},
    transfer: async () => {},
    onTransferred: async () => () => {},
    acknowledge: async () => {},
    onAcknowledged: async () => () => {},
    ...overrides,
  };
}

async function connectedWindows() {
  type Incoming = Parameters<WindowClient["onTransferred"]>[0];
  type Ack = Parameters<WindowClient["onAcknowledged"]>[0];
  const incoming = new Map<string, Incoming>();
  const acks = new Map<string, Ack>();
  const connection = (id: string) =>
    fakeWindowClient({
      currentId: async () => id,
      transfer: async (from, to, tabJson) => {
        incoming.get(to)?.({ from, to, tabJson });
      },
      acknowledge: async (to, ack) => {
        acks.get(to)?.(ack);
      },
      onTransferred: async (listener) => {
        incoming.set(id, listener);
        return () => {
          incoming.delete(id);
        };
      },
      onAcknowledged: async (listener) => {
        acks.set(id, listener);
        return () => {
          acks.delete(id);
        };
      },
    });
  const source = createAppStore({ env: { newId: sequentialIds("source") } });
  const target = createAppStore({ env: { newId: sequentialIds("target") } });
  const sourceLayout = () => source.getState().layout;
  const targetLayout = () => target.getState().layout;
  const sourceClient = connection("source");
  const stopSource = await subscribeToTransferredTabs(sourceLayout, source.dispatch, vi.fn(), sourceClient);
  const stopTarget = await subscribeToTransferredTabs(targetLayout, target.dispatch, vi.fn(), connection("target"));
  return {
    source,
    target,
    sourceClient,
    sourceLayout,
    targetLayout,
    stop: () => {
      stopSource();
      stopTarget();
    },
  };
}

describe("tab transfer layouts", () => {
  it("round-trips one tab and its pane information without changing the receiver's other tabs", () => {
    const source = createAppStore({ env: { newId: sequentialIds("source") } });
    source.dispatch(layout({ type: "tab/new" }));
    const sourceLayout = source.getState().layout;
    const tabId = sourceLayout.activeTab;
    expect(tabId).not.toBeNull();
    if (!tabId) return;
    const sourceTab = sourceLayout.tabs.find((tab) => tab.id === tabId);
    expect(sourceTab).toBeDefined();
    if (!sourceTab) return;

    const encoded = tabTransferJson(sourceLayout, tabId);
    const target = createAppStore({ env: { newId: sequentialIds("target") } });
    const targetBefore = target.getState().layout;
    const inserted = insertTransferredTab(targetBefore, encoded);
    expect(inserted.tabs).toHaveLength(2);
    expect(inserted.tabs[1]?.id).toBe(tabId);
    expect(Object.keys(inserted.panes)).toHaveLength(2);

    const removed = removeTransferredTab(sourceLayout, tabId);
    expect(removed.tabs).toHaveLength(1);
    for (const id of paneIds(sourceTab.root)) expect(removed.panes[id]).toBeUndefined();
    expect(insertTransferredTab(inserted, encoded)).toBe(inserted);
  });

  it("leaves the source layout untouched when the native transfer fails", async () => {
    const store = createAppStore({ env: { newId: sequentialIds("source") } });
    const before = store.getState().layout;
    const transfer = vi.fn(async () => {
      throw new Error("destination closed");
    });
    restoreClient = setWindowClient(fakeWindowClient({ transfer }));

    await expect(transferTab(before, store.dispatch, before.activeTab ?? "", "window-1")).rejects.toThrow(
      "destination closed",
    );
    expect(store.getState().layout).toBe(before);
    expect(transfer.mock.calls).toHaveLength(2);
  });

  it("waits for live panes, detaches the source and moves back through a fresh transfer", async () => {
    const fixture = await connectedWindows();
    const { source, sourceClient, sourceLayout, targetLayout, stop } = fixture;
    const id = sourceLayout().activeTab!;
    const pane = sourceLayout().tabs[0]!.focusedPane;
    const unregister = registerPaneTerminal(pane, {
      transferSession: () => ({ sessionId: "live" }),
      reclaimSession: vi.fn(),
    } as unknown as PaneTerminal);
    try {
      const moved = transferTab(sourceLayout(), source.dispatch, id, "target", sourceLayout, sourceClient);
      await vi.waitFor(() => expect(targetLayout().panes[pane]?.transfer?.sessionId).toBe("live"));
      expect(sourceLayout().activeTab).toBe(id);
      const transfer = targetLayout().panes[pane]!.transfer!;
      transferReadiness.get(transfer.id)?.(pane, true);
      const result = await moved;
      expect(sourceLayout().panes[pane]).toBeUndefined();
      expect(consumeTransferDetach(pane)).toBe(true);
      expect(targetLayout().panes[pane]?.transfer?.pending).toBe(false);
      restoreClient = setWindowClient(sourceClient);
      await undoTabTransfer(result.tabJson, "source", "target");
      await vi.waitFor(() => expect(sourceLayout().panes[pane]?.transfer?.pending).toBe(true));
      transferReadiness.get(sourceLayout().panes[pane]!.transfer!.id)?.(pane, true);
      await vi.waitFor(() => expect(targetLayout().panes[pane]).toBeUndefined());
      expect(sourceLayout().panes[pane]?.transfer?.pending).toBe(false);
    } finally {
      unregister();
      stop();
    }
  });

  it("rolls back a rejected payload, a timeout and simultaneous offers for the same tab", async () => {
    const fixture = await connectedWindows();
    const { source, sourceClient, sourceLayout, targetLayout, stop } = fixture;
    const id = sourceLayout().activeTab!;
    const pane = sourceLayout().tabs[0]!.focusedPane;
    const reclaim = vi.fn(async () => {});
    const unregister = registerPaneTerminal(pane, {
      transferSession: () => ({ sessionId: "live" }),
      reclaimSession: reclaim,
    } as unknown as PaneTerminal);
    try {
      const corrupt = {
        ...sourceClient,
        transfer: (from: string, to: string, json: string) => {
          const message = JSON.parse(json);
          if (message.operation === "offer") message.tabJson = "{bad json";
          return sourceClient.transfer(from, to, JSON.stringify(message));
        },
      };
      await expect(transferTab(sourceLayout(), source.dispatch, id, "target", sourceLayout, corrupt)).rejects.toThrow(
        "could not attach",
      );
      expect(targetLayout().panes[pane]).toBeUndefined();

      vi.useFakeTimers();
      const timeout = transferTab(sourceLayout(), source.dispatch, id, "target", sourceLayout, sourceClient);
      const rejected = expect(timeout).rejects.toThrow("did not confirm");
      await vi.advanceTimersByTimeAsync(0);
      expect(targetLayout().panes[pane]?.transfer?.pending).toBe(true);
      await expect(
        transferTab(sourceLayout(), source.dispatch, id, "target", sourceLayout, sourceClient),
      ).rejects.toThrow("already moving");
      await vi.advanceTimersByTimeAsync(5000);
      await rejected;
      expect(sourceLayout().panes[pane]).toBeDefined();
      expect(targetLayout().panes[pane]).toBeUndefined();
      expect(reclaim).toHaveBeenCalledWith("live");
    } finally {
      vi.useRealTimers();
      unregister();
      stop();
    }
  });

  it("carries an exited pane without waiting for a replacement shell or persisting runtime data", async () => {
    const { source, sourceClient, sourceLayout, targetLayout, stop } = await connectedWindows();
    const pane = sourceLayout().tabs[0]!.focusedPane;
    const unregister = registerPaneTerminal(pane, {
      transferSession: () => ({ exitCode: 7 }),
    } as unknown as PaneTerminal);
    try {
      await transferTab(
        sourceLayout(),
        source.dispatch,
        sourceLayout().activeTab!,
        "target",
        sourceLayout,
        sourceClient,
      );
      expect(targetLayout().panes[pane]?.transfer?.exitCode).toBe(7);
      expect(JSON.stringify(serializeLayout(targetLayout()))).not.toContain("exitCode");
    } finally {
      unregister();
      stop();
    }
  });

  it("rejects malformed or multi-tab payloads", () => {
    const state = createAppStore({ env: { newId: sequentialIds("target") } }).getState().layout;
    expect(() => insertTransferredTab(state, "{bad json")).toThrow("invalid");
    const source = createAppStore({ env: { newId: sequentialIds("source") } });
    source.dispatch(layout({ type: "tab/new" }));
    const twoTabs = JSON.stringify({
      ...JSON.parse(tabTransferJson(source.getState().layout, source.getState().layout.tabs[0]?.id ?? "")),
      tabs: source.getState().layout.tabs.map((tab) => ({
        id: tab.id,
        title: tab.title,
        color: tab.color,
        pinned: tab.pinned,
        focused_pane: tab.focusedPane,
        root: { pane: tab.focusedPane, session_id: null, kind: "shell" },
      })),
    });
    expect(() => insertTransferredTab(state, twoTabs)).toThrow("exactly one tab");
  });
});
