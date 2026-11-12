import { describe, expect, it } from "vitest";
import { type LayoutState, layoutReducer, MIN_RATIO, paneTitle, type SplitNode } from "../../src/layout";
import { activeTab, assertInvariants, setup, shape } from "./helpers";

const root = (state: LayoutState) => activeTab(state).root;
const split = (state: LayoutState) => {
  const node = root(state);
  if (node.type !== "split") throw new Error("root is not a split");
  return node;
};

/** p1 | p2 over p3 | p4, built by splitting: a 2×2 grid as a row of two columns. */
function grid() {
  const s = setup();
  const first = activeTab(s.state).focusedPane;
  s.run({ type: "pane/split", direction: "right" });
  const second = activeTab(s.state).focusedPane;
  s.run({ type: "pane/split", direction: "down" });
  const fourth = activeTab(s.state).focusedPane;
  s.run({ type: "pane/focus", paneId: first }, { type: "pane/split", direction: "down" });
  const third = activeTab(s.state).focusedPane;
  return { s, topLeft: first, topRight: second, bottomLeft: third, bottomRight: fourth };
}

describe("pane/split", () => {
  it("splits right into a row, focuses the new pane and copies the cwd", () => {
    const s = setup("/srv/web");
    const source = activeTab(s.state).focusedPane;
    s.run({ type: "pane/split", direction: "right" });
    const tab = activeTab(s.state);
    expect(shape(tab.root)).toBe(`row(${source},${tab.focusedPane})`);
    expect(s.state.panes[tab.focusedPane]?.cwd).toBe("/srv/web");
    expect(split(s.state).ratios).toEqual([0.5, 0.5]);
    assertInvariants(s.state);
  });

  it("adds a sibling when the parent already splits that way (n-ary), halving the source's share", () => {
    const s = setup();
    const a = activeTab(s.state).focusedPane;
    s.run({ type: "pane/split", direction: "right" });
    const b = activeTab(s.state).focusedPane;
    s.run({ type: "pane/focus", paneId: a }, { type: "pane/split", direction: "right" });
    const c = activeTab(s.state).focusedPane;
    expect(shape(root(s.state))).toBe(`row(${a},${c},${b})`);
    expect(split(s.state).ratios).toEqual([0.25, 0.25, 0.5]);
    assertInvariants(s.state);
  });

  it("nests a split when the direction differs", () => {
    const s = setup();
    const a = activeTab(s.state).focusedPane;
    s.run({ type: "pane/split", direction: "right" });
    const b = activeTab(s.state).focusedPane;
    s.run({ type: "pane/split", direction: "down" });
    const c = activeTab(s.state).focusedPane;
    expect(shape(root(s.state))).toBe(`row(${a},col(${b},${c}))`);
  });

  it("splitting while zoomed un-zooms", () => {
    const s = setup();
    s.run({ type: "pane/split", direction: "right" }, { type: "pane/zoomToggle" });
    expect(activeTab(s.state).zoomedPane).not.toBeNull();
    s.run({ type: "pane/split", direction: "down" });
    expect(activeTab(s.state).zoomedPane).toBeNull();
  });

  it("ignores an unknown pane", () => {
    const s = setup();
    const before = s.state;
    expect(layoutReducer(before, { type: "pane/split", paneId: "x", direction: "down" }, s.env)).toBe(before);
  });
});

describe("pane/close", () => {
  it("the sibling takes the space and the focus", () => {
    const s = setup();
    const a = activeTab(s.state).focusedPane;
    s.run({ type: "pane/split", direction: "down" }, { type: "pane/close" });
    const tab = activeTab(s.state);
    expect(tab.root).toMatchObject({ type: "pane", id: a });
    expect(tab.focusedPane).toBe(a);
    assertInvariants(s.state);
  });

  it("in a 3-way split the neighbour before it takes its share (the one after, for the first pane)", () => {
    const s = setup();
    const a = activeTab(s.state).focusedPane;
    s.run({ type: "pane/split", direction: "right" });
    const b = activeTab(s.state).focusedPane;
    s.run({ type: "pane/split", direction: "right" });
    const c = activeTab(s.state).focusedPane;
    expect(split(s.state).ratios).toEqual([0.5, 0.25, 0.25]);
    s.run({ type: "pane/close", paneId: b });
    expect(shape(root(s.state))).toBe(`row(${a},${c})`);
    expect(split(s.state).ratios).toEqual([0.75, 0.25]);
    expect(activeTab(s.state).focusedPane).toBe(c);
    s.run({ type: "pane/close", paneId: a });
    expect(root(s.state)).toMatchObject({ type: "pane", id: c });
    assertInvariants(s.state);
  });

  it("moves focus to the nearest pane of the heir when the focused pane closes", () => {
    const { s, topRight, bottomRight, bottomLeft } = grid();
    // Close the bottom-left pane: its column collapses to the top-left pane, which takes the focus.
    s.run({ type: "pane/focus", paneId: bottomLeft }, { type: "pane/close" });
    const tab = activeTab(s.state);
    expect(shape(tab.root)).toBe(`row(n1,col(${topRight},${bottomRight}))`);
    expect(tab.focusedPane).toBe("n1");
    assertInvariants(s.state);
  });

  it("closing the last pane closes the tab", () => {
    const s = setup();
    s.run({ type: "tab/new" });
    const tabId = s.state.activeTab;
    s.run({ type: "pane/close" });
    expect(s.state.tabs.map((tab) => tab.id)).not.toContain(tabId);
    expect(s.state.tabs).toHaveLength(1);
    assertInvariants(s.state);
  });

  it("collapses a nested split into its parent when it is left with one child of the parent's direction", () => {
    const s = setup();
    const a = activeTab(s.state).focusedPane;
    s.run({ type: "pane/split", direction: "right" });
    const b = activeTab(s.state).focusedPane;
    s.run({ type: "pane/split", direction: "down" });
    const c = activeTab(s.state).focusedPane;
    s.run({ type: "pane/split", direction: "right" });
    const d = activeTab(s.state).focusedPane;
    expect(shape(root(s.state))).toBe(`row(${a},col(${b},row(${c},${d})))`);
    s.run({ type: "pane/close", paneId: b });
    // col(row(c,d)) collapses and row(c,d) merges into the root row.
    expect(shape(root(s.state))).toBe(`row(${a},${c},${d})`);
    expect(split(s.state).ratios.reduce((x, y) => x + y)).toBeCloseTo(1);
    assertInvariants(s.state);
  });
});

describe("pane/focusDirection on a 2×2 grid", () => {
  it("moves by geometry in all four directions and stops at the edges", () => {
    const { s, topLeft, topRight, bottomLeft, bottomRight } = grid();
    const focus = (direction: "left" | "right" | "up" | "down") => {
      s.run({ type: "pane/focusDirection", direction });
      return activeTab(s.state).focusedPane;
    };
    s.run({ type: "pane/focus", paneId: topLeft });
    expect(focus("right")).toBe(topRight);
    expect(focus("down")).toBe(bottomRight);
    expect(focus("left")).toBe(bottomLeft);
    expect(focus("up")).toBe(topLeft);
    expect(focus("up")).toBe(topLeft);
    expect(focus("left")).toBe(topLeft);
  });

  it("prefers the neighbour that shares the most edge, not tree order", () => {
    const { s, topLeft, topRight, bottomRight } = grid();
    const col = split(s.state).children[1] as SplitNode;
    // Make the right column's top pane short: the top-left pane now shares more edge with the bottom-right pane.
    s.run({ type: "pane/resize", splitId: col.id, index: 0, delta: -0.4 });
    s.run({ type: "pane/focus", paneId: topLeft }, { type: "pane/focusDirection", direction: "right" });
    expect(activeTab(s.state).focusedPane).toBe(bottomRight);
    expect(activeTab(s.state).focusedPane).not.toBe(topRight);
  });

  it("un-zooms when focus moves away", () => {
    const { s, topLeft } = grid();
    s.run({ type: "pane/focus", paneId: topLeft }, { type: "pane/zoomToggle" });
    s.run({ type: "pane/focusDirection", direction: "right" });
    expect(activeTab(s.state).zoomedPane).toBeNull();
  });
});

describe("pane/resize", () => {
  it("moves a divider and clamps to the minimum share", () => {
    const s = setup();
    s.run({ type: "pane/split", direction: "right" });
    const id = split(s.state).id;
    s.run({ type: "pane/resize", splitId: id, index: 0, delta: 0.2 });
    expect(split(s.state).ratios[0]).toBeCloseTo(0.7);
    s.run({ type: "pane/resize", splitId: id, index: 0, delta: 5 });
    const [left, right] = split(s.state).ratios;
    expect(left).toBeCloseTo(1 - MIN_RATIO);
    expect(right).toBeCloseTo(MIN_RATIO);
    s.run({ type: "pane/resize", splitId: id, index: 0, delta: -5, minRatio: 0.3 });
    expect(split(s.state).ratios[0]).toBeCloseTo(0.3);
    assertInvariants(s.state);
  });

  it("ignores a divider that does not exist and a delta that is not a number", () => {
    const s = setup();
    s.run({ type: "pane/split", direction: "right" });
    const before = s.state;
    const id = split(before).id;
    expect(layoutReducer(before, { type: "pane/resize", splitId: id, index: 1, delta: 0.1 }, s.env)).toBe(before);
    expect(layoutReducer(before, { type: "pane/resize", splitId: id, index: 0, delta: Number.NaN }, s.env)).toBe(
      before,
    );
    expect(layoutReducer(before, { type: "pane/resize", splitId: "nope", index: 0, delta: 0.1 }, s.env)).toBe(before);
  });

  it("resizeFocused moves the divider next to the focused pane in the arrow's direction", () => {
    const s = setup();
    const a = activeTab(s.state).focusedPane;
    s.run({ type: "pane/split", direction: "right" });
    s.run({ type: "pane/focus", paneId: a }, { type: "pane/resizeFocused", direction: "right", delta: 0.1 });
    expect(split(s.state).ratios[0]).toBeCloseTo(0.6);
    s.run({ type: "pane/resizeFocused", direction: "left", delta: 0.1 });
    expect(split(s.state).ratios[0]).toBeCloseTo(0.5);
    // No split on the vertical axis: nothing to move.
    const before = s.state;
    expect(layoutReducer(before, { type: "pane/resizeFocused", direction: "up", delta: 0.1 }, s.env)).toBe(before);
  });
});

describe("pane/equalize", () => {
  it("gives equal shares in every split of the tab, or in one split", () => {
    const s = setup();
    s.run({ type: "pane/split", direction: "right" }, { type: "pane/split", direction: "right" });
    s.run({ type: "pane/split", direction: "down" });
    s.run({ type: "pane/equalize" });
    const top = split(s.state);
    expect(top.ratios).toEqual([1 / 3, 1 / 3, 1 / 3]);
    const inner = top.children[2] as SplitNode;
    s.run({ type: "pane/resize", splitId: inner.id, index: 0, delta: 0.2 });
    s.run({ type: "pane/resize", splitId: top.id, index: 0, delta: 0.1 });
    s.run({ type: "pane/equalize", splitId: inner.id });
    expect((split(s.state).children[2] as SplitNode).ratios).toEqual([0.5, 0.5]);
    expect(split(s.state).ratios[0]).not.toBeCloseTo(1 / 3);
    assertInvariants(s.state);
  });
});

describe("pane/zoomToggle", () => {
  it("zooms the focused pane and back; a single pane cannot zoom", () => {
    const s = setup();
    const before = s.state;
    expect(layoutReducer(before, { type: "pane/zoomToggle" }, s.env)).toBe(before);
    s.run({ type: "pane/split", direction: "right" }, { type: "pane/zoomToggle" });
    const tab = activeTab(s.state);
    expect(tab.zoomedPane).toBe(tab.focusedPane);
    s.run({ type: "pane/zoomToggle" });
    expect(activeTab(s.state).zoomedPane).toBeNull();
  });

  it("closing the zoomed pane clears the zoom", () => {
    const s = setup();
    s.run({ type: "pane/split", direction: "right" }, { type: "pane/split", direction: "down" });
    s.run({ type: "pane/zoomToggle" }, { type: "pane/close" });
    expect(activeTab(s.state).zoomedPane).toBeNull();
    assertInvariants(s.state);
  });
});

describe("pane/swap and pane info", () => {
  it("swaps two panes and keeps the focus on the same pane", () => {
    const s = setup();
    const a = activeTab(s.state).focusedPane;
    s.run({ type: "pane/split", direction: "right" });
    const b = activeTab(s.state).focusedPane;
    s.run({ type: "pane/swap", paneId: a, withPaneId: b });
    expect(shape(root(s.state))).toBe(`row(${b},${a})`);
    expect(activeTab(s.state).focusedPane).toBe(b);
    assertInvariants(s.state);
  });

  it("does not swap panes of different tabs", () => {
    const s = setup();
    const a = activeTab(s.state).focusedPane;
    s.run({ type: "tab/new" });
    const b = activeTab(s.state).focusedPane;
    const before = s.state;
    expect(layoutReducer(before, { type: "pane/swap", paneId: a, withPaneId: b }, s.env)).toBe(before);
  });

  it("records cwd, title and running process, and ignores unknown panes", () => {
    const s = setup();
    const id = activeTab(s.state).focusedPane;
    s.run(
      { type: "pane/setCwd", paneId: id, cwd: "/var/log" },
      { type: "pane/setTitle", paneId: id, title: "tail -f" },
      { type: "pane/setProcess", paneId: id, process: "npm run dev" },
    );
    expect(s.state.panes[id]).toEqual({ cwd: "/var/log", programTitle: "tail -f", runningProcess: "npm run dev" });
    const before = s.state;
    expect(layoutReducer(before, { type: "pane/setCwd", paneId: "ghost", cwd: "/" }, s.env)).toBe(before);
    expect(layoutReducer(before, { type: "pane/setCwd", paneId: id, cwd: "/var/log" }, s.env)).toBe(before);
  });
});

describe("sidebar", () => {
  it("toggles hidden, or the overlay in a narrow window, and clamps the width", () => {
    const s = setup();
    s.run({ type: "sidebar/toggle" });
    expect(s.state.sidebar.hidden).toBe(true);
    s.run({ type: "sidebar/toggle", narrow: true });
    expect(s.state.sidebar).toMatchObject({ hidden: true, overlayOpen: true });
    s.run({ type: "sidebar/closeOverlay" });
    expect(s.state.sidebar.overlayOpen).toBe(false);
    s.run({ type: "sidebar/setWidth", width: 9000 });
    expect(s.state.sidebar.width).toBe(420);
    s.run({ type: "sidebar/setWidth", width: 10 });
    expect(s.state.sidebar.width).toBe(200);
  });
});

describe("pane/setName", () => {
  it("gives a pane a fixed name that wins over the program title, and null removes it", () => {
    const s = setup();
    const id = activeTab(s.state).focusedPane;
    s.run({ type: "pane/setTitle", paneId: id, title: "zsh" });
    s.run({ type: "pane/setName", paneId: id, name: "dev server" });
    expect(s.state.panes[id]?.name).toBe("dev server");
    expect(paneTitle(s.state.panes[id])).toBe("dev server");
    s.run({ type: "pane/setTitle", paneId: id, title: "node" });
    expect(paneTitle(s.state.panes[id])).toBe("dev server");
    s.run({ type: "pane/setName", paneId: id, name: null });
    expect(s.state.panes[id]?.name).toBeUndefined();
    expect(paneTitle(s.state.panes[id])).toBe("node");
    assertInvariants(s.state);
  });

  it("ignores an unknown pane and a repeated name (state is returned unchanged)", () => {
    const s = setup();
    const before = s.state;
    s.run({ type: "pane/setName", paneId: "nope" as never, name: "x" });
    expect(s.state).toBe(before);
    const id = activeTab(s.state).focusedPane;
    s.run({ type: "pane/setName", paneId: id, name: "a" });
    const named = s.state;
    s.run({ type: "pane/setName", paneId: id, name: "a" });
    expect(s.state).toBe(named);
  });
});
