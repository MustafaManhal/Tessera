import { describe, expect, it } from "vitest";
import { type LayoutJson, parseLayout, sequentialIds, serializeLayout } from "../../src/layout";
import { activeTab, assertInvariants, setup, shape } from "./helpers";

/** The §5.3 example, with real ids. */
const example: LayoutJson = {
  tabs: [
    {
      id: "01JTAB",
      title: null,
      color: null,
      pinned: false,
      focused_pane: "p2",
      root: {
        split: "row",
        ratios: [0.5, 0.5],
        children: [
          { pane: "p1", session_id: "01JS1", kind: "agent" },
          { pane: "p2", session_id: "01JS2", kind: "run" },
        ],
      },
    },
  ],
  active_tab: "01JTAB",
  sidebar: { width: 260, hidden: false },
  right_panel: { open: true, width: 420 },
};

const parse = (input: unknown) => parseLayout(input, { newId: sequentialIds("s"), cwd: "/home/me" });

describe("serializeLayout", () => {
  it("writes the §5.3 shape", () => {
    const s = setup();
    s.run({ type: "pane/split", direction: "right" }, { type: "tab/rename", title: "api" });
    s.run({ type: "tab/setColor", color: "blue" }, { type: "tab/pin" });
    const json = serializeLayout(s.state);
    expect(Object.keys(json).sort()).toEqual(["active_tab", "panes", "right_panel", "sidebar", "tabs", "version"]);
    expect(json.version).toBe(1);
    expect(Object.keys(json.panes ?? {})).toEqual(["n1", "n3"]);
    expect(json.panes?.n1).toMatchObject({ task_id: null });
    const [tab] = json.tabs;
    expect(tab).toMatchObject({ title: "api", color: "blue", pinned: true, focused_pane: "n3" });
    expect(tab?.root).toEqual({
      split: "row",
      ratios: [0.5, 0.5],
      children: [
        { pane: "n1", session_id: null, kind: "shell" },
        { pane: "n3", session_id: null, kind: "shell" },
      ],
    });
    expect(JSON.parse(JSON.stringify(json))).toEqual(json);
  });
});

describe("parseLayout", () => {
  it("reads the schema example", () => {
    const result = parse(example);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.repairs).toEqual([]);
    const tab = activeTab(result.value);
    expect(shape(tab.root)).toBe("row(p1,p2)");
    expect(tab.focusedPane).toBe("p2");
    expect(tab.root).toMatchObject({ children: [{ sessionId: "01JS1", kind: "agent" }, { kind: "run" }] });
    expect(result.value.panes.p1?.cwd).toBe("/home/me");
    expect(result.value.rightPanel).toEqual({ open: true, width: 420 });
    assertInvariants(result.value);
  });

  it("round-trips: serialize(parse(serialize(x))) equals serialize(x)", () => {
    const s = setup();
    s.run({ type: "pane/split", direction: "right" }, { type: "pane/split", direction: "down" });
    s.run({ type: "tab/new" }, { type: "pane/split", direction: "down" }, { type: "tab/pin" });
    s.run({ type: "tab/new" }, { type: "tab/rename", title: "logs" }, { type: "tab/setColor", color: "red" });
    s.run({ type: "sidebar/setWidth", width: 300 }, { type: "sidebar/toggle" });
    const json = serializeLayout(s.state);
    const parsed = parse(JSON.stringify(json));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(serializeLayout(parsed.value)).toEqual(json);
    expect(parsed.repairs).toEqual([]);
    assertInvariants(parsed.value);
  });

  it("repairs a missing or wrong focus id, an unknown active tab and bad ratios", () => {
    const damaged = structuredClone(example) as unknown as Record<string, unknown> & {
      tabs: Record<string, unknown>[];
    };
    const tab = damaged.tabs[0] as Record<string, unknown>;
    delete tab.focused_pane;
    (tab.root as Record<string, unknown>).ratios = [3, -1];
    damaged.active_tab = "gone";
    const result = parse(damaged);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(activeTab(result.value).focusedPane).toBe("p1");
    expect(result.value.activeTab).toBe("01JTAB");
    expect(activeTab(result.value).root).toMatchObject({ ratios: [0.5, 0.5] });
    expect(result.repairs.join("\n")).toMatch(/focused pane missing/);
    expect(result.repairs.join("\n")).toMatch(/active tab missing/);
    assertInvariants(result.value);
  });

  it("collapses a one-child split, merges a same-direction child and moves pinned tabs first", () => {
    const input = {
      tabs: [
        {
          id: "t1",
          pinned: false,
          focused_pane: "a",
          root: { split: "col", ratios: [1], children: [{ pane: "a", kind: "shell", session_id: null }] },
        },
        {
          id: "t2",
          pinned: true,
          focused_pane: "b",
          root: {
            split: "row",
            ratios: [0.5, 0.5],
            children: [
              { pane: "b", kind: "shell" },
              {
                split: "row",
                ratios: [0.5, 0.5],
                children: [
                  { pane: "c", kind: "shell" },
                  { pane: "d", kind: "weird" },
                ],
              },
            ],
          },
        },
      ],
      active_tab: "t1",
    };
    const result = parse(input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.tabs.map((tab) => tab.id)).toEqual(["t2", "t1"]);
    expect(shape(result.value.tabs[0]?.root ?? { type: "pane", id: "", sessionId: null, kind: "shell" })).toBe(
      "row(b,c,d)",
    );
    expect(result.value.tabs[1]?.root).toMatchObject({ type: "pane", id: "a" });
    expect(result.value.sidebar).toEqual({ width: 260, hidden: false, overlayOpen: false });
    expect(result.repairs.length).toBeGreaterThanOrEqual(3);
    assertInvariants(result.value);
  });

  it("accepts an empty window", () => {
    const result = parse({ tabs: [], active_tab: null });
    expect(result).toMatchObject({ ok: true });
    if (result.ok) expect(result.value.activeTab).toBeNull();
  });

  it.each([
    ["garbage text", "{not json"],
    ["null", null],
    ["a number", 42],
    ["an array", []],
    ["no tabs", { active_tab: "x" }],
    ["a tab that is a string", { tabs: ["tab"] }],
    ["a tab without id", { tabs: [{ root: { pane: "a" } }] }],
    ["a node that is neither", { tabs: [{ id: "t", root: { leaf: "a" } }] }],
    ["a pane without id", { tabs: [{ id: "t", root: { pane: "" } }] }],
    ["a split with a bad direction", { tabs: [{ id: "t", root: { split: "diagonal", children: [{ pane: "a" }] } }] }],
    ["a split without children", { tabs: [{ id: "t", root: { split: "row", ratios: [], children: [] } }] }],
    ["a duplicate pane id", { tabs: [{ id: "t", root: { split: "row", children: [{ pane: "a" }, { pane: "a" }] } }] }],
    [
      "a duplicate tab id",
      {
        tabs: [
          { id: "t", root: { pane: "a" } },
          { id: "t", root: { pane: "b" } },
        ],
      },
    ],
  ])("rejects %s without throwing", (_name, input) => {
    const result = parse(input);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/\w/);
  });

  it("rejects a tree deeper than the limit", () => {
    let node: unknown = { pane: "leaf" };
    for (let i = 0; i < 40; i++) node = { split: i % 2 ? "row" : "col", children: [node, { pane: `p${i}` }] };
    const result = parse({ tabs: [{ id: "t", root: node }] });
    expect(result).toMatchObject({ ok: false, error: expect.stringMatching(/too deep/) });
  });
});

describe("layout version, saved panes and task ids", () => {
  it("round-trips cwd and task id of every pane", () => {
    const s = setup();
    s.run({ type: "pane/split", direction: "right" });
    const state = {
      ...s.state,
      panes: {
        ...s.state.panes,
        n1: { cwd: "/home/me/shop", programTitle: "vim", runningProcess: "vim", taskId: "tsk_9" },
        n3: { cwd: "C:\\Users\\me", programTitle: null, runningProcess: null },
      },
    };
    const json = JSON.parse(JSON.stringify(serializeLayout(state)));
    const result = parse(json);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.panes.n1).toEqual({
      cwd: "/home/me/shop",
      programTitle: null,
      runningProcess: null,
      taskId: "tsk_9",
    });
    expect(result.value.panes.n3?.cwd).toBe("C:\\Users\\me");
    expect(result.value.panes.n3?.taskId).toBeUndefined();
  });

  it("reads old files without a version or panes, and ignores bad pane entries", () => {
    const old = {
      tabs: [
        {
          id: "t",
          title: null,
          color: null,
          pinned: false,
          focused_pane: "p",
          root: { pane: "p", session_id: null, kind: "shell" },
        },
      ],
      active_tab: "t",
    };
    const result = parse(old);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.panes.p?.cwd).toBe("/home/me");
    const junk = parse({ ...old, panes: { p: { cwd: 5, task_id: [] } } });
    expect(junk.ok && junk.value.panes.p).toEqual({ cwd: "/home/me", programTitle: null, runningProcess: null });
    const panesAreNotAnObject = parse({ ...old, panes: "nope" });
    expect(panesAreNotAnObject.ok).toBe(true);
  });

  it("refuses a layout from a newer version instead of guessing", () => {
    const result = parse({ version: 2, tabs: [], active_tab: null });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("version 2");
    expect(parse({ version: "2", tabs: [], active_tab: null }).ok).toBe(true);
  });
});
