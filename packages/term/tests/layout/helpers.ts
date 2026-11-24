// Shared helpers for the layout tests: a predictable id environment, a dispatcher, and the invariant checker the
// property test runs after every step.
import {
  CLOSED_TABS_MAX,
  createLayout,
  type LayoutAction,
  type LayoutEnv,
  type LayoutNode,
  type LayoutState,
  layoutReducer,
  paneIds,
  sequentialIds,
  splitNodes,
  type Tab,
} from "../../src/layout";

export function testEnv(prefix = "n"): LayoutEnv {
  return { newId: sequentialIds(prefix) };
}

/** A state plus a `run` that applies actions with the same id environment. */
export function setup(cwd = "/home/me/shop-api") {
  const env = testEnv();
  let state = createLayout(cwd, env);
  return {
    env,
    get state() {
      return state;
    },
    set state(next: LayoutState) {
      state = next;
    },
    run(...actions: LayoutAction[]) {
      for (const action of actions) state = layoutReducer(state, action, env);
      return state;
    },
  };
}

export function activeTab(state: LayoutState): Tab {
  const tab = state.tabs.find((t) => t.id === state.activeTab);
  if (!tab) throw new Error("no active tab");
  return tab;
}

/** A compact picture of a tree: `row(p1,col(p2,p3))`. */
export function shape(node: LayoutNode): string {
  if (node.type === "pane") return node.id;
  return `${node.direction}(${node.children.map(shape).join(",")})`;
}

/** Throws with a readable message when a layout breaks an invariant. */
export function assertInvariants(state: LayoutState): void {
  const fail = (message: string) => {
    throw new Error(`invariant: ${message}\n${JSON.stringify(state, null, 1).slice(0, 2000)}`);
  };
  if (state.tabs.length === 0) {
    if (state.activeTab !== null) fail("activeTab set with no tabs");
  } else if (state.tabs.filter((tab) => tab.id === state.activeTab).length !== 1) {
    fail("not exactly one selected tab");
  }

  const ids = new Set<string>();
  const unique = (id: string) => {
    if (ids.has(id)) fail(`duplicate id ${id}`);
    ids.add(id);
  };
  const allPanes: string[] = [];
  let seenUnpinned = false;
  for (const tab of state.tabs) {
    unique(tab.id);
    if (tab.pinned && seenUnpinned) fail(`pinned tab ${tab.id} after an unpinned one`);
    if (!tab.pinned) seenUnpinned = true;
    const panes = paneIds(tab.root);
    for (const id of panes) unique(id);
    allPanes.push(...panes);
    if (!panes.includes(tab.focusedPane)) fail(`tab ${tab.id} focuses a pane it does not have`);
    if (tab.zoomedPane !== null && !panes.includes(tab.zoomedPane)) fail(`tab ${tab.id} zooms a missing pane`);
    for (const split of splitNodes(tab.root)) {
      unique(split.id);
      if (split.children.length < 2) fail(`split ${split.id} has ${split.children.length} children`);
      if (split.ratios.length !== split.children.length) fail(`split ${split.id} ratios/children mismatch`);
      if (split.ratios.some((r) => !(r > 0 && r < 1))) fail(`split ${split.id} ratio out of range ${split.ratios}`);
      const sum = split.ratios.reduce((a, b) => a + b, 0);
      if (Math.abs(sum - 1) > 1e-9) fail(`split ${split.id} ratios sum to ${sum}`);
      for (const child of split.children) {
        if (child.type === "split" && child.direction === split.direction)
          fail(`split ${split.id} nests its direction`);
      }
    }
  }
  const infoIds = Object.keys(state.panes).sort();
  if (JSON.stringify(infoIds) !== JSON.stringify(allPanes.slice().sort())) fail("pane info does not match the panes");
  if (state.closedTabs.length > CLOSED_TABS_MAX) fail("too many closed tabs kept");
}

/** Seeded PRNG (mulberry32), so a failing random run can be replayed. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
