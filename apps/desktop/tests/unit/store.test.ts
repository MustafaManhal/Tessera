import { describe, expect, it } from "vitest";
import { context, runAction } from "../../src/actions/registry";
import { activeTabOf, sequentialIds } from "../../src/layout";
import { createAppStore } from "../../src/store";
import { layout } from "../../src/store/layoutSlice";
import { selectActiveTab, selectFocusedCwd, selectTabTitles } from "../../src/store/selectors";
import { setConfirmCloseRunning, setPaneDimUnfocused } from "../../src/store/settingsSlice";
import { closeOtherTabs, closePane, closeTab, performClose } from "../../src/store/thunks";
import { noteRecent, RECENT_MAX, setPaletteOpen, setSheetOpen } from "../../src/store/uiSlice";

const fresh = () => createAppStore({ env: { newId: sequentialIds("n") } });

describe("layout slice", () => {
  it("wraps the pure reducer: a split and a new tab", () => {
    const store = fresh();
    store.dispatch(layout({ type: "pane/split", direction: "right" }));
    store.dispatch(layout({ type: "tab/new" }));
    const state = store.getState().layout;
    expect(state.tabs).toHaveLength(2);
    expect(state.tabs[0]?.root.type).toBe("split");
    expect(state.activeTab).toBe(state.tabs[1]?.id);
  });

  it("keeps the same state object for a change that does not apply", () => {
    const store = fresh();
    const before = store.getState().layout;
    store.dispatch(layout({ type: "tab/select", tabId: "missing" }));
    expect(store.getState().layout).toBe(before);
  });
});

describe("selectors", () => {
  it("memoise: the same input gives the same output object", () => {
    const store = fresh();
    const a = selectTabTitles(store.getState());
    store.dispatch(setPaletteOpen(true));
    expect(selectTabTitles(store.getState())).toBe(a);
  });

  it("follow titles and the focused cwd", () => {
    const store = fresh();
    const tab = selectActiveTab(store.getState());
    if (!tab) throw new Error("no tab");
    expect(selectTabTitles(store.getState())[tab.id]).toBe("~");
    store.dispatch(layout({ type: "pane/setCwd", paneId: tab.focusedPane, cwd: "/srv/shop-api" }));
    expect(selectFocusedCwd(store.getState())).toBe("/srv/shop-api");
    expect(selectTabTitles(store.getState())[tab.id]).toBe("shop-api");
  });
});

describe("ui and settings slices", () => {
  it("opens one dialog at a time", () => {
    const store = fresh();
    store.dispatch(setSheetOpen(true));
    store.dispatch(setPaletteOpen(true));
    expect(store.getState().ui).toMatchObject({ paletteOpen: true, sheetOpen: false });
  });

  it("keeps recent actions unique, most recent first, at most RECENT_MAX", () => {
    const store = fresh();
    for (const id of ["a", "b", "a", "c", "d", "e", "f", "g"]) store.dispatch(noteRecent(id));
    expect(store.getState().ui.recentActions).toEqual(["g", "f", "e", "d", "c"].slice(0, RECENT_MAX));
  });

  it("clamps the pane dim setting", () => {
    const store = fresh();
    store.dispatch(setPaneDimUnfocused(3));
    expect(store.getState().settings.paneDimUnfocused).toBe(1);
  });
});

describe("listener effects", () => {
  it("asks for pane focus after a split, a new tab or a focus move, not after selecting a tab in the strip", () => {
    const store = fresh();
    const focus = () => store.getState().ui.paneFocusRequest;
    store.dispatch(layout({ type: "pane/split", direction: "down" }));
    expect(focus()).toBe(1);
    store.dispatch(layout({ type: "tab/new" }));
    expect(focus()).toBe(2);
    const first = store.getState().layout.tabs[0]?.id ?? "";
    store.dispatch(layout({ type: "tab/select", tabId: first }));
    expect(focus()).toBe(2);
    store.dispatch(layout({ type: "pane/focusDirection", direction: "up" }));
    expect(focus()).toBe(3);
    // An explicit focus target wins: a close from the tab strip keeps focus on the tabs.
    store.dispatch(layout({ type: "tab/close" }, "tab"));
    expect(focus()).toBe(3);
  });

  it("announces a tab moved with the keyboard", () => {
    const store = fresh();
    store.dispatch(layout({ type: "tab/new" }));
    store.dispatch(layout({ type: "tab/new" }));
    store.dispatch(layout({ type: "tab/move", offset: -1 }));
    expect(store.getState().ui.announcement?.text).toBe("~ moved to position 2 of 3");
    const id = store.getState().ui.announcement?.id;
    store.dispatch(layout({ type: "tab/move", offset: -1 }));
    expect(store.getState().ui.announcement).toEqual({ text: "~ moved to position 1 of 3", id: (id ?? 0) + 1 });
  });
});

describe("close thunks", () => {
  function withRunningProcess() {
    const store = fresh();
    const tab = activeTabOf(store.getState().layout);
    if (!tab) throw new Error("no tab");
    store.dispatch(layout({ type: "pane/setProcess", paneId: tab.focusedPane, process: "npm run dev" }));
    return { store, tab };
  }

  it("closes at once when nothing runs", () => {
    const store = fresh();
    store.dispatch(layout({ type: "tab/new" }));
    store.dispatch(closeTab());
    expect(store.getState().layout.tabs).toHaveLength(1);
    expect(store.getState().ui.confirm).toBeNull();
  });

  it("asks before closing a running process, and performClose then closes", () => {
    const { store, tab } = withRunningProcess();
    store.dispatch(closeTab());
    expect(store.getState().layout.tabs).toHaveLength(1);
    expect(store.getState().ui.confirm).toEqual({
      close: { kind: "tab", tabId: tab.id },
      title: "confirm.closeTab.title",
      processes: ["npm run dev"],
    });
    const pending = store.getState().ui.confirm;
    if (!pending) throw new Error("no confirm");
    store.dispatch(performClose(pending.close));
    expect(store.getState().layout.tabs).toHaveLength(0);
  });

  it("closing the last pane asks with the tab title; closing one of two asks with the pane title", () => {
    const { store } = withRunningProcess();
    store.dispatch(closePane());
    expect(store.getState().ui.confirm?.title).toBe("confirm.closeTab.title");
    store.dispatch(layout({ type: "pane/split", direction: "right" }));
    const first = store.getState().layout.tabs[0];
    if (first?.root.type !== "split") throw new Error("no split");
    const running = first.root.children[0];
    store.dispatch(closePane(running?.type === "pane" ? running.id : undefined));
    expect(store.getState().ui.confirm?.title).toBe("confirm.closePane.title");
  });

  it("skips the question when the setting says so", () => {
    const { store } = withRunningProcess();
    store.dispatch(setConfirmCloseRunning(false));
    store.dispatch(closeTab());
    expect(store.getState().layout.tabs).toHaveLength(0);
  });

  it("closeOtherTabs lists the processes of every tab it would close", () => {
    const { store, tab } = withRunningProcess();
    store.dispatch(layout({ type: "tab/new" }));
    store.dispatch(closeOtherTabs());
    expect(store.getState().ui.confirm).toMatchObject({ close: { kind: "others" }, processes: ["npm run dev"] });
    expect(store.getState().layout.tabs.map((t) => t.id)).toContain(tab.id);
  });
});

describe("registry actions on a store", () => {
  it("run through the context's dispatcher and respect availability", () => {
    const store = fresh();
    expect(runAction("pane.zoom", context(undefined, store))).toBe(false);
    expect(runAction("pane.splitRight", context(undefined, store))).toBe(true);
    expect(runAction("pane.zoom", context(undefined, store))).toBe(true);
    expect(activeTabOf(store.getState().layout)?.zoomedPane).not.toBeNull();
    expect(runAction("view.palette", context(undefined, store))).toBe(true);
    expect(store.getState().ui.paletteOpen).toBe(true);
  });
});
