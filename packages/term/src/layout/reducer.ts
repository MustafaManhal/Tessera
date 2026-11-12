// The layout reducer: every change to tabs, splits and panes goes through `layoutReducer(state, action)`. It is
// pure: new ids come from `env.newId`, so tests inject a predictable generator. An action that does not apply (an
// unknown id, nothing to close) returns the same state object.
import { layoutGeometry, neighbor } from "./geometry";
import { createIdGenerator, type IdGenerator } from "./ids";
import {
  equalRatios,
  findPane,
  findSplit,
  nodeAt,
  normalizeNode,
  paneIds,
  pathToPane,
  replaceAt,
  updateSplit,
  updateSplits,
} from "./tree";
import {
  CLOSED_TABS_MAX,
  type ClosedTab,
  type Direction,
  type LayoutNode,
  type LayoutState,
  MIN_RATIO,
  type PaneId,
  type PaneInfo,
  type PaneKind,
  type PaneNode,
  RIGHT_PANEL_WIDTH,
  SIDEBAR_WIDTH,
  type SplitId,
  type Tab,
  type TabColor,
  type TabId,
} from "./types";

export type LayoutAction =
  /** A new tab with one pane, after the existing tabs; it inherits the focused pane's cwd unless `cwd` is given. */
  | { type: "tab/new"; cwd?: string; kind?: PaneKind; taskId?: string; title?: string }
  | { type: "tab/close"; tabId?: TabId }
  /** Closes every other tab except pinned ones. */
  | { type: "tab/closeOthers"; tabId?: TabId }
  /** Moves a tab to `toIndex`; pinned tabs stay before unpinned ones. */
  | { type: "tab/reorder"; tabId: TabId; toIndex: number }
  /** Moves a tab by `offset` places (keyboard reorder). */
  | { type: "tab/move"; tabId?: TabId; offset: number }
  /** A title locks it; null or blank unlocks it. */
  | { type: "tab/rename"; tabId?: TabId; title: string | null }
  | { type: "tab/setColor"; tabId?: TabId; color: TabColor | null }
  /** Toggles pinning unless `pinned` is given. */
  | { type: "tab/pin"; tabId?: TabId; pinned?: boolean }
  | { type: "tab/select"; tabId: TabId }
  /** 0-based; past the end selects the last tab; -1 is the last tab. */
  | { type: "tab/selectIndex"; index: number }
  /** Next (+1) or previous (-1), wrapping. */
  | { type: "tab/selectRelative"; offset: number }
  | { type: "tab/reopen" }
  /** Splits a pane (default: the focused one); the new pane takes its cwd and the focus. */
  | { type: "pane/split"; paneId?: PaneId; direction: "right" | "down"; kind?: PaneKind }
  /** The neighbour that shared the edge takes the space; the last pane closes the tab. */
  | { type: "pane/close"; paneId?: PaneId }
  | { type: "pane/focus"; paneId: PaneId }
  | { type: "pane/focusDirection"; direction: Direction }
  /** Moves the divider after child `index` of a split by `delta` (a share of the split's size). */
  | { type: "pane/resize"; splitId: SplitId; index: number; delta: number; minRatio?: number }
  /** Moves the divider next to the focused pane in `direction` by `delta`. */
  | { type: "pane/resizeFocused"; direction: Direction; delta: number; minRatio?: number }
  /** Equal shares in one split, or in every split of the active tab. */
  | { type: "pane/equalize"; splitId?: SplitId }
  | { type: "pane/zoomToggle"; paneId?: PaneId }
  | { type: "pane/swap"; paneId: PaneId; withPaneId: PaneId }
  /** The program title (OSC 0/2); null clears it. */
  | { type: "pane/setTitle"; paneId: PaneId; title: string | null }
  /** Gives a pane a fixed name (a run script's); null removes it. */
  | { type: "pane/setName"; paneId: PaneId; name: string | null }
  | { type: "pane/setCwd"; paneId: PaneId; cwd: string }
  | { type: "pane/setProcess"; paneId: PaneId; process: string | null }
  /** The program an agent pane runs; null clears it. Runtime only. */
  | {
      type: "pane/setLaunch";
      paneId: PaneId;
      launch: { program: string; args: string[]; env: Record<string, string> } | null;
    }
  /** Replaces the launch and bumps the pane's restart key, so the terminal spawns again in place. */
  | {
      type: "pane/relaunch";
      paneId: PaneId;
      launch: { program: string; args: string[]; env: Record<string, string> };
    }
  /** Hides or shows the sidebar; in a narrow window it opens or closes the overlay instead. */
  | { type: "sidebar/toggle"; narrow?: boolean }
  | { type: "sidebar/setWidth"; width: number }
  /** Makes sure the sidebar is on screen (opens the overlay when narrow). */
  | { type: "sidebar/show"; narrow?: boolean }
  | { type: "sidebar/closeOverlay" }
  /** Replaces everything, e.g. with a parsed saved layout (M3.4). */
  | { type: "layout/replace"; state: LayoutState };

export interface LayoutEnv {
  newId: IdGenerator;
}

const defaultEnv: LayoutEnv = { newId: createIdGenerator() };

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

function newPane(env: LayoutEnv, kind: PaneKind = "shell"): PaneNode {
  return { type: "pane", id: env.newId(), sessionId: null, kind };
}

function paneInfo(cwd: string, taskId?: string): PaneInfo {
  return taskId === undefined
    ? { cwd, programTitle: null, runningProcess: null }
    : { cwd, programTitle: null, runningProcess: null, taskId };
}

function newTab(env: LayoutEnv, pane: PaneNode): Tab {
  return {
    id: env.newId(),
    title: null,
    color: null,
    pinned: false,
    root: pane,
    focusedPane: pane.id,
    zoomedPane: null,
  };
}

/** A window with one tab and one shell pane in `cwd`. */
export function createLayout(cwd = "", env: LayoutEnv = defaultEnv): LayoutState {
  const pane = newPane(env);
  const tab = newTab(env, pane);
  return {
    tabs: [tab],
    activeTab: tab.id,
    panes: { [pane.id]: paneInfo(cwd) },
    sidebar: { width: SIDEBAR_WIDTH.default, hidden: false, overlayOpen: false },
    rightPanel: { open: false, width: RIGHT_PANEL_WIDTH.default },
    closedTabs: [],
  };
}

export function activeTabOf(state: LayoutState): Tab | undefined {
  return state.tabs.find((tab) => tab.id === state.activeTab);
}

export function tabOfPane(state: LayoutState, paneId: PaneId): Tab | undefined {
  return state.tabs.find((tab) => findPane(tab.root, paneId) !== null);
}

function resolveTab(state: LayoutState, tabId: TabId | undefined): Tab | undefined {
  return tabId === undefined ? activeTabOf(state) : state.tabs.find((tab) => tab.id === tabId);
}

function replaceTab(state: LayoutState, tab: Tab): LayoutState {
  return { ...state, tabs: state.tabs.map((t) => (t.id === tab.id ? tab : t)) };
}

function pinnedCount(tabs: readonly Tab[]): number {
  return tabs.filter((tab) => tab.pinned).length;
}

/** Moves `tab` (already removed from `tabs`) to `index`, kept inside its group: pinned first, then unpinned. */
function insertTab(tabs: readonly Tab[], tab: Tab, index: number): Tab[] {
  const pinned = pinnedCount(tabs);
  const at = tab.pinned ? clamp(index, 0, pinned) : clamp(index, pinned, tabs.length);
  return [...tabs.slice(0, at), tab, ...tabs.slice(at)];
}

function withoutPanes(panes: Record<PaneId, PaneInfo>, ids: readonly PaneId[]): Record<PaneId, PaneInfo> {
  const next = { ...panes };
  for (const id of ids) delete next[id];
  return next;
}

function pickPanes(panes: Record<PaneId, PaneInfo>, ids: readonly PaneId[]): Record<PaneId, PaneInfo> {
  return Object.fromEntries(ids.flatMap((id) => (panes[id] ? [[id, panes[id]]] : [])));
}

/** Closes tabs (in order), remembers them for "Reopen closed tab" and picks the next active tab. */
function closeTabs(state: LayoutState, ids: ReadonlySet<TabId>): LayoutState {
  if (ids.size === 0) return state;
  const closed: ClosedTab[] = [];
  let panes = state.panes;
  state.tabs.forEach((tab, index) => {
    if (!ids.has(tab.id)) return;
    const owned = paneIds(tab.root);
    closed.push({ tab: { ...tab, zoomedPane: null }, index, panes: pickPanes(state.panes, owned) });
    panes = withoutPanes(panes, owned);
  });
  const tabs = state.tabs.filter((tab) => !ids.has(tab.id));
  let activeTab = state.activeTab;
  if (activeTab === null || ids.has(activeTab)) {
    // APG tabs: focus moves to the following tab, or the preceding one when the closed tab was last.
    const oldIndex = state.tabs.findIndex((tab) => tab.id === state.activeTab);
    const following = state.tabs.slice(oldIndex + 1).find((tab) => !ids.has(tab.id));
    const preceding = state.tabs
      .slice(0, Math.max(oldIndex, 0))
      .reverse()
      .find((tab) => !ids.has(tab.id));
    activeTab = (following ?? preceding ?? tabs[0])?.id ?? null;
  }
  return {
    ...state,
    tabs,
    activeTab,
    panes,
    closedTabs: [...state.closedTabs, ...closed].slice(-CLOSED_TABS_MAX),
  };
}

function focusPane(state: LayoutState, paneId: PaneId): LayoutState {
  const tab = tabOfPane(state, paneId);
  if (!tab) return state;
  const zoomedPane = tab.zoomedPane !== null && tab.zoomedPane !== paneId ? null : tab.zoomedPane;
  if (state.activeTab === tab.id && tab.focusedPane === paneId && zoomedPane === tab.zoomedPane) return state;
  return { ...replaceTab(state, { ...tab, focusedPane: paneId, zoomedPane }), activeTab: tab.id };
}

function splitPane(
  state: LayoutState,
  paneId: PaneId | undefined,
  side: "right" | "down",
  kind: PaneKind | undefined,
  env: LayoutEnv,
): LayoutState {
  const tab = paneId === undefined ? activeTabOf(state) : tabOfPane(state, paneId);
  if (!tab) return state;
  const sourceId = paneId ?? tab.focusedPane;
  const path = pathToPane(tab.root, sourceId);
  const source = findPane(tab.root, sourceId);
  if (!path || !source) return state;
  const direction = side === "right" ? "row" : "col";
  const added = newPane(env, kind);
  const parentPath = path.slice(0, -1);
  const index = path.at(-1);
  const parent = nodeAt(tab.root, parentPath);
  let root: LayoutNode;
  if (parent?.type === "split" && parent.direction === direction && index !== undefined) {
    // Same direction as the parent: add a sibling and halve the source's share (n-ary split, §5.3).
    const share = (parent.ratios[index] ?? 0) / 2;
    const children = [...parent.children.slice(0, index + 1), added, ...parent.children.slice(index + 1)];
    const ratios = [...parent.ratios.slice(0, index), share, share, ...parent.ratios.slice(index + 1)];
    root = replaceAt(tab.root, parentPath, { ...parent, children, ratios });
  } else {
    root = replaceAt(tab.root, path, {
      type: "split",
      id: env.newId(),
      direction,
      ratios: [0.5, 0.5],
      children: [source, added],
    });
  }
  const cwd = state.panes[sourceId]?.cwd ?? "";
  const taskId = state.panes[sourceId]?.taskId;
  const next = replaceTab(state, { ...tab, root: normalizeNode(root), focusedPane: added.id, zoomedPane: null });
  return { ...next, activeTab: tab.id, panes: { ...state.panes, [added.id]: paneInfo(cwd, taskId) } };
}

function closePane(state: LayoutState, paneId: PaneId | undefined): LayoutState {
  const tab = paneId === undefined ? activeTabOf(state) : tabOfPane(state, paneId);
  if (!tab) return state;
  const targetId = paneId ?? tab.focusedPane;
  const path = pathToPane(tab.root, targetId);
  if (!path) return state;
  if (path.length === 0) return closeTabs(state, new Set([tab.id]));

  const parentPath = path.slice(0, -1);
  const index = path.at(-1) ?? 0;
  const parent = nodeAt(tab.root, parentPath);
  if (parent?.type !== "split") return state;
  // The sibling before the pane takes its share (or the one after, when it was first): the edge it shared.
  const heir = index > 0 ? index - 1 : 1;
  const ratios = parent.ratios.slice();
  ratios[heir] = (ratios[heir] ?? 0) + (ratios[index] ?? 0);
  ratios.splice(index, 1);
  const children = parent.children.filter((_, i) => i !== index);
  const heirNode = parent.children[heir];
  const root = normalizeNode(replaceAt(tab.root, parentPath, { ...parent, children, ratios }));

  let focusedPane = tab.focusedPane;
  if (focusedPane === targetId && heirNode) {
    // Focus the pane of the heir closest to where the closed pane was.
    const { panes } = layoutGeometry(tab.root);
    const gone = panes.get(targetId);
    const candidates = paneIds(heirNode);
    const distance = (id: PaneId) => {
      const rect = panes.get(id);
      if (!rect || !gone) return 0;
      return Math.hypot(rect.x + rect.w / 2 - (gone.x + gone.w / 2), rect.y + rect.h / 2 - (gone.y + gone.h / 2));
    };
    focusedPane = candidates.reduce((best, id) => (distance(id) < distance(best) ? id : best), candidates[0] ?? "");
  }
  const zoomedPane = tab.zoomedPane === targetId ? null : tab.zoomedPane;
  const next = replaceTab(state, { ...tab, root, focusedPane, zoomedPane });
  return { ...next, panes: withoutPanes(state.panes, [targetId]) };
}

function resizeSplit(
  state: LayoutState,
  tab: Tab,
  splitId: SplitId,
  index: number,
  delta: number,
  minRatio: number = MIN_RATIO,
): LayoutState {
  const split = findSplit(tab.root, splitId);
  if (!split || !Number.isFinite(delta)) return state;
  const before = split.ratios[index];
  const after = split.ratios[index + 1];
  if (before === undefined || after === undefined) return state;
  const total = before + after;
  const min = clamp(minRatio, 0, total / 2);
  const nextBefore = clamp(before + delta, min, total - min);
  if (Math.abs(nextBefore - before) < 1e-12) return state;
  const root = updateSplit(tab.root, splitId, (node) => {
    const ratios = node.ratios.slice();
    ratios[index] = nextBefore;
    ratios[index + 1] = total - nextBefore;
    return { ...node, ratios };
  });
  return replaceTab(state, { ...tab, root });
}

function resizeFocused(state: LayoutState, direction: Direction, delta: number, minRatio?: number): LayoutState {
  const tab = activeTabOf(state);
  if (!tab) return state;
  const path = pathToPane(tab.root, tab.focusedPane);
  if (!path) return state;
  const axis = direction === "left" || direction === "right" ? "row" : "col";
  const forward = direction === "right" || direction === "down";
  // Walk up from the pane to the nearest split on this axis; move the divider on the side of the arrow, or the
  // other side when the pane is at that end. The divider always moves in the arrow's direction.
  for (let depth = path.length - 1; depth >= 0; depth--) {
    const split = nodeAt(tab.root, path.slice(0, depth));
    const index = path[depth];
    if (split?.type !== "split" || split.direction !== axis || index === undefined) continue;
    const last = split.children.length - 1;
    const divider = forward ? (index < last ? index : index - 1) : index > 0 ? index - 1 : index;
    return resizeSplit(state, tab, split.id, divider, forward ? delta : -delta, minRatio);
  }
  return state;
}

function moveTab(state: LayoutState, tabId: TabId, toIndex: number): LayoutState {
  const from = state.tabs.findIndex((tab) => tab.id === tabId);
  const tab = state.tabs[from];
  if (!tab) return state;
  const rest = state.tabs.filter((t) => t.id !== tabId);
  const tabs = insertTab(rest, tab, Math.trunc(toIndex));
  if (tabs.every((t, i) => t === state.tabs[i])) return state;
  return { ...state, tabs };
}

export function layoutReducer(state: LayoutState, action: LayoutAction, env: LayoutEnv = defaultEnv): LayoutState {
  switch (action.type) {
    case "tab/new": {
      const focused = activeTabOf(state)?.focusedPane;
      const cwd = action.cwd ?? (focused ? state.panes[focused]?.cwd : undefined) ?? "";
      const pane = newPane(env, action.kind);
      const tab = { ...newTab(env, pane), title: action.title?.trim() ? action.title.trim() : null };
      return {
        ...state,
        tabs: [...state.tabs, tab],
        activeTab: tab.id,
        panes: { ...state.panes, [pane.id]: paneInfo(cwd, action.taskId) },
      };
    }

    case "tab/close": {
      const tab = resolveTab(state, action.tabId);
      return tab ? closeTabs(state, new Set([tab.id])) : state;
    }

    case "tab/closeOthers": {
      const keep = resolveTab(state, action.tabId);
      if (!keep) return state;
      const ids = new Set(state.tabs.filter((tab) => tab.id !== keep.id && !tab.pinned).map((tab) => tab.id));
      const next = closeTabs(state, ids);
      return next === state ? state : { ...next, activeTab: keep.id };
    }

    case "tab/reorder":
      return moveTab(state, action.tabId, action.toIndex);

    case "tab/move": {
      const tab = resolveTab(state, action.tabId);
      if (!tab) return state;
      return moveTab(state, tab.id, state.tabs.indexOf(tab) + Math.trunc(action.offset));
    }

    case "tab/rename": {
      const tab = resolveTab(state, action.tabId);
      if (!tab) return state;
      const title = action.title?.trim() ? action.title.trim() : null;
      return title === tab.title ? state : replaceTab(state, { ...tab, title });
    }

    case "tab/setColor": {
      const tab = resolveTab(state, action.tabId);
      if (!tab || tab.color === action.color) return state;
      return replaceTab(state, { ...tab, color: action.color });
    }

    case "tab/pin": {
      const tab = resolveTab(state, action.tabId);
      if (!tab) return state;
      const pinned = action.pinned ?? !tab.pinned;
      if (pinned === tab.pinned) return state;
      const rest = state.tabs.filter((t) => t.id !== tab.id);
      // Pinning puts the tab at the end of the pinned group; unpinning at the start of the others.
      return { ...state, tabs: insertTab(rest, { ...tab, pinned }, pinnedCount(rest)) };
    }

    case "tab/select":
      return state.activeTab !== action.tabId && state.tabs.some((tab) => tab.id === action.tabId)
        ? { ...state, activeTab: action.tabId }
        : state;

    case "tab/selectIndex": {
      if (state.tabs.length === 0 || !Number.isInteger(action.index)) return state;
      const index = action.index < 0 ? state.tabs.length + action.index : Math.min(action.index, state.tabs.length - 1);
      const tab = state.tabs[index];
      return tab && tab.id !== state.activeTab ? { ...state, activeTab: tab.id } : state;
    }

    case "tab/selectRelative": {
      const count = state.tabs.length;
      if (count < 2 || !Number.isInteger(action.offset)) return state;
      const current = state.tabs.findIndex((tab) => tab.id === state.activeTab);
      const tab = state.tabs[(((current + action.offset) % count) + count) % count];
      return tab && tab.id !== state.activeTab ? { ...state, activeTab: tab.id } : state;
    }

    case "tab/reopen": {
      const entry = state.closedTabs.at(-1);
      if (!entry) return state;
      return {
        ...state,
        tabs: insertTab(state.tabs, entry.tab, entry.index),
        activeTab: entry.tab.id,
        panes: { ...state.panes, ...entry.panes },
        closedTabs: state.closedTabs.slice(0, -1),
      };
    }

    case "pane/split":
      return splitPane(state, action.paneId, action.direction, action.kind, env);

    case "pane/close":
      return closePane(state, action.paneId);

    case "pane/focus":
      return focusPane(state, action.paneId);

    case "pane/focusDirection": {
      const tab = activeTabOf(state);
      if (!tab) return state;
      const target = neighbor(tab, tab.focusedPane, action.direction);
      return target ? focusPane(state, target) : state;
    }

    case "pane/resize": {
      const tab = state.tabs.find((t) => findSplit(t.root, action.splitId));
      return tab ? resizeSplit(state, tab, action.splitId, action.index, action.delta, action.minRatio) : state;
    }

    case "pane/resizeFocused":
      return resizeFocused(state, action.direction, action.delta, action.minRatio);

    case "pane/equalize": {
      const tab =
        action.splitId === undefined
          ? activeTabOf(state)
          : state.tabs.find((t) => findSplit(t.root, action.splitId ?? ""));
      if (!tab || tab.root.type === "pane") return state;
      const equalize = (split: Extract<LayoutNode, { type: "split" }>) => ({
        ...split,
        ratios: equalRatios(split.children.length),
      });
      const root =
        action.splitId === undefined
          ? updateSplits(tab.root, equalize)
          : updateSplit(tab.root, action.splitId, equalize);
      return replaceTab(state, { ...tab, root });
    }

    case "pane/zoomToggle": {
      const tab = action.paneId === undefined ? activeTabOf(state) : tabOfPane(state, action.paneId);
      if (!tab || tab.root.type === "pane") return state;
      if (tab.zoomedPane !== null) return replaceTab(state, { ...tab, zoomedPane: null });
      const paneId = action.paneId ?? tab.focusedPane;
      return { ...replaceTab(state, { ...tab, zoomedPane: paneId, focusedPane: paneId }), activeTab: tab.id };
    }

    case "pane/swap": {
      const tab = tabOfPane(state, action.paneId);
      if (!tab || action.paneId === action.withPaneId) return state;
      const a = findPane(tab.root, action.paneId);
      const b = findPane(tab.root, action.withPaneId);
      const pathA = pathToPane(tab.root, action.paneId);
      const pathB = pathToPane(tab.root, action.withPaneId);
      if (!a || !b || !pathA || !pathB) return state;
      const root = replaceAt(replaceAt(tab.root, pathA, b), pathB, a);
      return replaceTab(state, { ...tab, root });
    }

    case "pane/setName": {
      const info = state.panes[action.paneId];
      if (!info || (info.name ?? null) === action.name) return state;
      const { name: _old, ...rest } = info;
      return {
        ...state,
        panes: { ...state.panes, [action.paneId]: action.name ? { ...rest, name: action.name } : rest },
      };
    }
    case "pane/setTitle":
    case "pane/setCwd":
    case "pane/setProcess": {
      const info = state.panes[action.paneId];
      if (!info) return state;
      const next =
        action.type === "pane/setTitle"
          ? { ...info, programTitle: action.title }
          : action.type === "pane/setCwd"
            ? { ...info, cwd: action.cwd }
            : { ...info, runningProcess: action.process };
      if (
        next.programTitle === info.programTitle &&
        next.cwd === info.cwd &&
        next.runningProcess === info.runningProcess
      )
        return state;
      return { ...state, panes: { ...state.panes, [action.paneId]: next } };
    }

    case "pane/setLaunch": {
      const info = state.panes[action.paneId];
      if (!info) return state;
      const { launch: _old, ...rest } = info;
      return {
        ...state,
        panes: { ...state.panes, [action.paneId]: action.launch ? { ...rest, launch: action.launch } : rest },
      };
    }

    case "pane/relaunch": {
      const info = state.panes[action.paneId];
      if (!info) return state;
      return {
        ...state,
        panes: {
          ...state.panes,
          [action.paneId]: { ...info, launch: action.launch, restartKey: (info.restartKey ?? 0) + 1 },
        },
      };
    }

    case "sidebar/toggle": {
      const { sidebar } = state;
      return {
        ...state,
        sidebar: action.narrow
          ? { ...sidebar, overlayOpen: !sidebar.overlayOpen }
          : { ...sidebar, hidden: !sidebar.hidden, overlayOpen: false },
      };
    }

    case "sidebar/show": {
      const { sidebar } = state;
      if (action.narrow) return sidebar.overlayOpen ? state : { ...state, sidebar: { ...sidebar, overlayOpen: true } };
      return sidebar.hidden ? { ...state, sidebar: { ...sidebar, hidden: false } } : state;
    }

    case "sidebar/setWidth": {
      if (!Number.isFinite(action.width)) return state;
      const width = clamp(Math.round(action.width), SIDEBAR_WIDTH.min, SIDEBAR_WIDTH.max);
      return width === state.sidebar.width ? state : { ...state, sidebar: { ...state.sidebar, width } };
    }

    case "sidebar/closeOverlay":
      return state.sidebar.overlayOpen ? { ...state, sidebar: { ...state.sidebar, overlayOpen: false } } : state;

    case "layout/replace":
      return action.state;
  }
}
