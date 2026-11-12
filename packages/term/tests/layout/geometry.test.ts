import { describe, expect, it } from "vitest";
import { baseName, layoutGeometry, neighbor, paneRects, runningProcesses } from "../../src/layout";
import { activeTab, setup } from "./helpers";

describe("paneRects and dividers", () => {
  it("lays a row out by its ratios and leaves no gap", () => {
    const s = setup();
    s.run({ type: "pane/split", direction: "right" }, { type: "pane/split", direction: "right" });
    const tab = activeTab(s.state);
    const rects = Object.values(paneRects(tab, 1000, 600));
    expect(rects.map((r) => r.w)).toEqual([500, 250, 250]);
    expect(rects.every((r) => r.h === 600 && r.y === 0)).toBe(true);
    expect(rects.map((r) => r.x)).toEqual([0, 500, 750]);
    const { dividers } = layoutGeometry(tab.root, { x: 0, y: 0, w: 1000, h: 600 });
    expect(dividers.map((d) => [d.x, d.index, d.position])).toEqual([
      [500, 0, 0.5],
      [750, 1, 0.75],
    ]);
    expect(dividers.every((d) => d.direction === "row" && d.length === 600)).toBe(true);
  });

  it("nests a column inside a row", () => {
    const s = setup();
    s.run({ type: "pane/split", direction: "right" }, { type: "pane/split", direction: "down" });
    const tab = activeTab(s.state);
    const rects = paneRects(tab, 800, 400);
    expect(Object.values(rects)).toEqual([
      { x: 0, y: 0, w: 400, h: 400 },
      { x: 400, y: 0, w: 400, h: 200 },
      { x: 400, y: 200, w: 400, h: 200 },
    ]);
  });
});

describe("neighbor", () => {
  it("returns null at an edge and for an unknown pane", () => {
    const s = setup();
    const tab = activeTab(s.state);
    expect(neighbor(tab, tab.focusedPane, "left")).toBeNull();
    expect(neighbor(tab, "nope", "right")).toBeNull();
  });

  it("breaks a tie by the closest centre", () => {
    // row(a, col(b, c, d)): a touches all three on the right; the middle one is closest to a's centre.
    const s = setup();
    const a = activeTab(s.state).focusedPane;
    s.run({ type: "pane/split", direction: "right" }, { type: "pane/split", direction: "down" });
    s.run({ type: "pane/split", direction: "down" });
    s.run({ type: "pane/equalize" });
    const tab = activeTab(s.state);
    const right = neighbor(tab, a, "right");
    expect(right).not.toBeNull();
    const rects = paneRects(tab, 1, 1);
    const rect = rects[right as string];
    expect(rect?.y).toBeCloseTo(1 / 3);
  });
});

describe("selectors", () => {
  it("baseName handles POSIX, Windows, root and trailing slashes", () => {
    expect(baseName("/Users/me/shop-api")).toBe("shop-api");
    expect(baseName("/Users/me/shop-api/")).toBe("shop-api");
    expect(baseName("C:\\code\\web")).toBe("web");
    expect(baseName("/")).toBe("/");
    expect(baseName("~")).toBe("~");
    expect(baseName("")).toBe("");
  });

  it("lists the running processes of a tab", () => {
    const s = setup();
    const a = activeTab(s.state).focusedPane;
    s.run({ type: "pane/split", direction: "right" });
    const b = activeTab(s.state).focusedPane;
    s.run({ type: "pane/setProcess", paneId: b, process: "npm run dev" });
    expect(runningProcesses(s.state, activeTab(s.state))).toEqual(["npm run dev"]);
    s.run(
      { type: "pane/setProcess", paneId: b, process: null },
      { type: "pane/setProcess", paneId: a, process: "vim" },
    );
    expect(runningProcesses(s.state, activeTab(s.state))).toEqual(["vim"]);
  });
});
