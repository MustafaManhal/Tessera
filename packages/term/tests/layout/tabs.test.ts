import { describe, expect, it } from "vitest";
import { CLOSED_TABS_MAX, layoutReducer, tabTitle } from "../../src/layout";
import { activeTab, assertInvariants, setup } from "./helpers";

const titles = (s: ReturnType<typeof setup>) => s.state.tabs.map((tab) => tab.id);

describe("tab/new", () => {
  it("adds a selected tab at the end that inherits the focused pane's cwd", () => {
    const s = setup("/home/me/shop-api");
    const first = activeTab(s.state);
    s.run({ type: "tab/new" });
    expect(s.state.tabs).toHaveLength(2);
    const tab = activeTab(s.state);
    expect(tab.id).not.toBe(first.id);
    expect(s.state.tabs.at(-1)).toBe(tab);
    expect(s.state.panes[tab.focusedPane]?.cwd).toBe("/home/me/shop-api");
    assertInvariants(s.state);
  });

  it("uses the given cwd and kind", () => {
    const s = setup();
    s.run({ type: "tab/new", cwd: "/tmp", kind: "agent" });
    const tab = activeTab(s.state);
    expect(s.state.panes[tab.focusedPane]?.cwd).toBe("/tmp");
    expect(tab.root).toMatchObject({ type: "pane", kind: "agent", sessionId: null });
  });
});

describe("tab/close", () => {
  it("selects the following tab, or the preceding one when the closed tab was last", () => {
    const s = setup();
    s.run({ type: "tab/new" }, { type: "tab/new" });
    const [a, b, c] = titles(s);
    s.run({ type: "tab/select", tabId: b as string }, { type: "tab/close" });
    expect(s.state.activeTab).toBe(c);
    s.run({ type: "tab/close" });
    expect(s.state.activeTab).toBe(a);
    assertInvariants(s.state);
  });

  it("drops the panes of the closed tab and remembers the tab", () => {
    const s = setup();
    s.run({ type: "tab/new" }, { type: "pane/split", direction: "right" });
    const closing = activeTab(s.state);
    s.run({ type: "tab/close" });
    expect(Object.keys(s.state.panes)).toHaveLength(1);
    expect(s.state.closedTabs.at(-1)?.tab.id).toBe(closing.id);
    assertInvariants(s.state);
  });

  it("closing the last tab leaves no tabs and no selection", () => {
    const s = setup();
    s.run({ type: "tab/close" });
    expect(s.state.tabs).toEqual([]);
    expect(s.state.activeTab).toBeNull();
    expect(s.state.panes).toEqual({});
    assertInvariants(s.state);
  });

  it("ignores an unknown tab id", () => {
    const s = setup();
    const before = s.state;
    expect(layoutReducer(before, { type: "tab/close", tabId: "nope" }, s.env)).toBe(before);
  });
});

describe("tab/reopen", () => {
  it("puts the last closed tab back where it was, with its panes and selection", () => {
    const s = setup();
    s.run({ type: "tab/new" }, { type: "tab/new" });
    const [, middle] = titles(s);
    s.run({ type: "tab/select", tabId: middle as string }, { type: "pane/split", direction: "down" });
    const panesBefore = Object.keys(s.state.panes).sort();
    s.run({ type: "tab/close" }, { type: "tab/reopen" });
    expect(titles(s)[1]).toBe(middle);
    expect(s.state.activeTab).toBe(middle);
    expect(Object.keys(s.state.panes).sort()).toEqual(panesBefore);
    expect(s.state.closedTabs).toHaveLength(0);
    assertInvariants(s.state);
  });

  it("does nothing with nothing closed", () => {
    const s = setup();
    const before = s.state;
    expect(layoutReducer(before, { type: "tab/reopen" }, s.env)).toBe(before);
  });

  it("keeps at most CLOSED_TABS_MAX closed tabs", () => {
    const s = setup();
    for (let i = 0; i < CLOSED_TABS_MAX + 5; i++) s.run({ type: "tab/new" }, { type: "tab/close" });
    expect(s.state.closedTabs).toHaveLength(CLOSED_TABS_MAX);
    assertInvariants(s.state);
  });
});

describe("pinned tabs", () => {
  it("pinning moves a tab to the end of the pinned group; unpinning to the start of the others", () => {
    const s = setup();
    s.run({ type: "tab/new" }, { type: "tab/new" }, { type: "tab/new" });
    const [a, b, c, d] = titles(s) as [string, string, string, string];
    s.run({ type: "tab/pin", tabId: c }, { type: "tab/pin", tabId: a });
    expect(titles(s)).toEqual([c, a, b, d]);
    s.run({ type: "tab/pin", tabId: c });
    expect(titles(s)).toEqual([a, c, b, d]);
    expect(s.state.tabs[1]?.pinned).toBe(false);
    assertInvariants(s.state);
  });

  it("closeOthers keeps the target and pinned tabs", () => {
    const s = setup();
    s.run({ type: "tab/new" }, { type: "tab/new" }, { type: "tab/new" });
    const [a, b, c, d] = titles(s) as [string, string, string, string];
    s.run({ type: "tab/pin", tabId: b }, { type: "tab/closeOthers", tabId: d });
    expect(titles(s)).toEqual([b, d]);
    expect(s.state.activeTab).toBe(d);
    expect(s.state.closedTabs.map((entry) => entry.tab.id)).toEqual([a, c]);
    assertInvariants(s.state);
  });

  it("reorder cannot move an unpinned tab into the pinned group, or a pinned one out of it", () => {
    const s = setup();
    s.run({ type: "tab/new" }, { type: "tab/new" });
    const [a, b, c] = titles(s) as [string, string, string];
    s.run({ type: "tab/pin", tabId: a });
    s.run({ type: "tab/reorder", tabId: c, toIndex: 0 });
    expect(titles(s)).toEqual([a, c, b]);
    s.run({ type: "tab/reorder", tabId: a, toIndex: 2 });
    expect(titles(s)).toEqual([a, c, b]);
    assertInvariants(s.state);
  });

  it("an explicit close still closes a pinned tab", () => {
    const s = setup();
    s.run({ type: "tab/new" }, { type: "tab/pin" }, { type: "tab/close" });
    expect(s.state.tabs).toHaveLength(1);
  });
});

describe("tab/reorder and tab/move", () => {
  it("moves a tab to an index and clamps out-of-range indexes", () => {
    const s = setup();
    s.run({ type: "tab/new" }, { type: "tab/new" });
    const [a, b, c] = titles(s) as [string, string, string];
    s.run({ type: "tab/reorder", tabId: a, toIndex: 2 });
    expect(titles(s)).toEqual([b, c, a]);
    s.run({ type: "tab/reorder", tabId: a, toIndex: -5 });
    expect(titles(s)).toEqual([a, b, c]);
    s.run({ type: "tab/move", tabId: b, offset: 1 });
    expect(titles(s)).toEqual([a, c, b]);
    s.run({ type: "tab/move", tabId: b, offset: 1 });
    expect(titles(s)).toEqual([a, c, b]);
  });

  it("returns the same state when nothing moves", () => {
    const s = setup();
    const before = s.state;
    expect(layoutReducer(before, { type: "tab/move", offset: -1 }, s.env)).toBe(before);
  });
});

describe("tab/select, tab/selectIndex, tab/selectRelative", () => {
  it("selects by id, by index (past the end and -1 select the last) and relative with wrapping", () => {
    const s = setup();
    s.run({ type: "tab/new" }, { type: "tab/new" });
    const [a, b, c] = titles(s) as [string, string, string];
    s.run({ type: "tab/select", tabId: a });
    expect(s.state.activeTab).toBe(a);
    s.run({ type: "tab/selectIndex", index: 1 });
    expect(s.state.activeTab).toBe(b);
    s.run({ type: "tab/selectIndex", index: 8 });
    expect(s.state.activeTab).toBe(c);
    s.run({ type: "tab/selectIndex", index: 0 }, { type: "tab/selectIndex", index: -1 });
    expect(s.state.activeTab).toBe(c);
    s.run({ type: "tab/selectRelative", offset: 1 });
    expect(s.state.activeTab).toBe(a);
    s.run({ type: "tab/selectRelative", offset: -1 });
    expect(s.state.activeTab).toBe(c);
  });

  it("ignores an unknown id", () => {
    const s = setup();
    const before = s.state;
    expect(layoutReducer(before, { type: "tab/select", tabId: "missing" }, s.env)).toBe(before);
  });
});

describe("titles", () => {
  it("follows the program title, then the cwd, until a manual title locks it", () => {
    const s = setup("/home/me/shop-api");
    const tab = () => activeTab(s.state);
    expect(tabTitle(s.state, tab())).toBe("shop-api");
    s.run({ type: "pane/setTitle", paneId: tab().focusedPane, title: "vim README.md" });
    expect(tabTitle(s.state, tab())).toBe("vim README.md");
    s.run({ type: "tab/rename", title: "  api  " });
    expect(tab().title).toBe("api");
    s.run({ type: "pane/setTitle", paneId: tab().focusedPane, title: "htop" });
    expect(tabTitle(s.state, tab())).toBe("api");
    s.run({ type: "tab/rename", title: "   " });
    expect(tab().title).toBeNull();
    expect(tabTitle(s.state, tab())).toBe("htop");
  });

  it("sets and clears a colour", () => {
    const s = setup();
    s.run({ type: "tab/setColor", color: "green" });
    expect(activeTab(s.state).color).toBe("green");
    s.run({ type: "tab/setColor", color: null });
    expect(activeTab(s.state).color).toBeNull();
  });
});
