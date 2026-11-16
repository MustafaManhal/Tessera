// Property-style test: thousands of random actions (seeded, so a failure can be replayed) must never break the
// layout invariants. See `assertInvariants` in helpers.ts.
import { describe, expect, it } from "vitest";
import {
  createLayout,
  type Direction,
  type LayoutAction,
  type LayoutState,
  layoutReducer,
  paneIds,
  parseLayout,
  sequentialIds,
  serializeLayout,
  splitNodes,
  TAB_COLORS,
} from "../../src/layout";
import { assertInvariants, seededRandom, testEnv } from "./helpers";

const STEPS = 2000;
const DIRECTIONS: Direction[] = ["left", "right", "up", "down"];

function randomAction(state: LayoutState, random: () => number): LayoutAction {
  const pick = <T>(items: readonly T[]): T | undefined => items[Math.floor(random() * items.length)];
  const tabIds = state.tabs.map((tab) => tab.id);
  const panes = state.tabs.flatMap((tab) => paneIds(tab.root));
  const splits = state.tabs.flatMap((tab) => splitNodes(tab.root));
  // Sometimes an id that does not exist, to exercise the "ignore" paths.
  const tabId = random() < 0.1 ? "missing-tab" : (pick(tabIds) ?? "none");
  const paneId = random() < 0.1 ? "missing-pane" : (pick(panes) ?? "none");
  const split = pick(splits);
  const roll = Math.floor(random() * 26);
  switch (roll) {
    case 0:
    case 1:
      return { type: "tab/new" };
    case 2:
      return { type: "tab/close", tabId: random() < 0.5 ? undefined : tabId };
    case 3:
      return { type: "tab/closeOthers", tabId };
    case 4:
      return { type: "tab/reorder", tabId, toIndex: Math.floor(random() * 8) - 2 };
    case 5:
      return { type: "tab/move", offset: random() < 0.5 ? -1 : 1 };
    case 6:
      return { type: "tab/rename", tabId, title: random() < 0.3 ? null : `t${Math.floor(random() * 100)}` };
    case 7:
      return { type: "tab/setColor", color: pick([...TAB_COLORS, null]) ?? null };
    case 8:
      return { type: "tab/pin", tabId };
    case 9:
      return { type: "tab/select", tabId };
    case 10:
      return { type: "tab/selectIndex", index: Math.floor(random() * 12) - 2 };
    case 11:
      return { type: "tab/selectRelative", offset: random() < 0.5 ? -1 : 1 };
    case 12:
      return { type: "tab/reopen" };
    case 13:
    case 14:
    case 15:
      return {
        type: "pane/split",
        paneId: random() < 0.5 ? undefined : paneId,
        direction: random() < 0.5 ? "right" : "down",
      };
    case 16:
    case 17:
      return { type: "pane/close", paneId: random() < 0.5 ? undefined : paneId };
    case 18:
      return { type: "pane/focus", paneId };
    case 19:
      return { type: "pane/focusDirection", direction: pick(DIRECTIONS) ?? "left" };
    case 20:
      return split
        ? {
            type: "pane/resize",
            splitId: split.id,
            index: Math.floor(random() * split.children.length),
            delta: (random() - 0.5) * 1.5,
            minRatio: random() < 0.5 ? undefined : random() * 0.3,
          }
        : { type: "pane/equalize" };
    case 21:
      return { type: "pane/resizeFocused", direction: pick(DIRECTIONS) ?? "up", delta: random() * 0.5 };
    case 22:
      return { type: "pane/equalize", splitId: random() < 0.5 ? undefined : split?.id };
    case 23:
      return { type: "pane/zoomToggle" };
    case 24:
      return { type: "pane/swap", paneId, withPaneId: pick(panes) ?? "none" };
    default:
      return { type: "pane/setProcess", paneId, process: random() < 0.5 ? null : "npm run dev" };
  }
}

describe("layout invariants under random actions", () => {
  for (const seed of [1, 42, 20261109]) {
    it(`holds for ${STEPS} random steps (seed ${seed})`, () => {
      const random = seededRandom(seed);
      const env = testEnv(`s${seed}-`);
      let state = createLayout("/home/me", env);
      const counts: Record<string, number> = {};
      let mostPanes = 0;
      for (let step = 0; step < STEPS; step++) {
        const action = randomAction(state, random);
        counts[action.type] = (counts[action.type] ?? 0) + 1;
        state = layoutReducer(state, action, env);
        mostPanes = Math.max(mostPanes, ...state.tabs.map((tab) => paneIds(tab.root).length), 0);
        try {
          assertInvariants(state);
        } catch (error) {
          throw new Error(`step ${step} (${JSON.stringify(action)}): ${(error as Error).message}`);
        }
        // Every 100 steps the JSON must round-trip too.
        if (step % 100 === 0) {
          const parsed = parseLayout(JSON.stringify(serializeLayout(state)), { newId: sequentialIds(`r${step}-`) });
          expect(parsed.ok).toBe(true);
          if (parsed.ok) {
            assertInvariants(parsed.value);
            expect(serializeLayout(parsed.value)).toEqual(serializeLayout(state));
          }
        }
      }
      // The run must have exercised every action type it can generate (22), not a corner of the reducer.
      expect(Object.keys(counts).length).toBe(22);
      // …and built real trees, not only single panes.
      expect(mostPanes).toBeGreaterThanOrEqual(5);
    });
  }

  it("the checker itself rejects broken layouts", () => {
    const env = testEnv();
    const state = layoutReducer(createLayout("/", env), { type: "pane/split", direction: "right" }, env);
    const tab = state.tabs[0];
    if (tab?.root.type !== "split") throw new Error("setup failed");
    const oneChild = { ...tab.root, children: tab.root.children.slice(0, 1), ratios: [1] };
    expect(() => assertInvariants({ ...state, tabs: [{ ...tab, root: oneChild }] })).toThrow(/children|pane info/);
    expect(() => assertInvariants({ ...state, activeTab: "nope" })).toThrow(/selected tab/);
    expect(() => assertInvariants({ ...state, tabs: [{ ...tab, focusedPane: "ghost" }] })).toThrow(/focuses/);
    const badRatios = { ...tab.root, ratios: [0.7, 0.7] };
    expect(() => assertInvariants({ ...state, tabs: [{ ...tab, root: badRatios }] })).toThrow(/out of range|sum/);
  });
});
