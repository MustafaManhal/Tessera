// The layout JSON stored in `layouts.state` (05-backend-schema §5.3) and its parser. `parseLayout` never throws:
// garbage gives `{ ok: false, error }`; small damage (a missing focus id, ratios that do not add up, a one-child
// split, a pinned tab after an unpinned one) is repaired and listed in `repairs`.
import { createIdGenerator, type IdGenerator } from "./ids";
import { normalizeNode, paneIds, splitNodes } from "./tree";
import {
  type LayoutNode,
  type LayoutState,
  PANE_KINDS,
  type PaneId,
  type PaneInfo,
  type PaneKind,
  RIGHT_PANEL_WIDTH,
  SIDEBAR_WIDTH,
  TAB_COLORS,
  type Tab,
  type TabColor,
} from "./types";

export type NodeJson =
  | { pane: string; session_id: string | null; kind: PaneKind }
  | { split: "row" | "col"; ratios: number[]; children: NodeJson[] };

export interface TabJson {
  id: string;
  title: string | null;
  color: string | null;
  pinned: boolean;
  focused_pane: string;
  root: NodeJson;
}

/** The layout JSON version this code writes and reads. A file with a higher one comes from a newer Tessera. */
export const LAYOUT_VERSION = 1;

/** Per-pane facts a restart needs (the `pane_sessions` columns it can use): where the shell was, and which task. */
export interface PaneJson {
  cwd: string;
  task_id: string | null;
}

export interface LayoutJson {
  /** Absent in files written before versions existed (read as 1). */
  version?: number;
  tabs: TabJson[];
  active_tab: string | null;
  sidebar: { width: number; hidden: boolean };
  right_panel: { open: boolean; width: number };
  /** Pane id → its saved cwd and task (an additive extension of §5.3; older files have none). */
  panes?: Record<string, PaneJson>;
}

export type ParseResult = { ok: true; value: LayoutState; repairs: string[] } | { ok: false; error: string };

function nodeToJson(node: LayoutNode): NodeJson {
  if (node.type === "pane") return { pane: node.id, session_id: node.sessionId, kind: node.kind };
  return { split: node.direction, ratios: node.ratios.slice(), children: node.children.map(nodeToJson) };
}

/** The layout as §5.3 JSON. Runtime-only state (program titles, zoom, closed tabs) is left out; cwd and task are kept. */
export function serializeLayout(state: LayoutState): LayoutJson {
  const panes: Record<string, PaneJson> = {};
  const tabs = state.tabs.filter((tab) => !paneIds(tab.root).some((id) => state.panes[id]?.transfer?.pending));
  for (const tab of tabs) {
    for (const id of paneIds(tab.root)) {
      const info = state.panes[id];
      if (info) panes[id] = { cwd: info.cwd, task_id: info.taskId ?? null };
    }
  }
  return {
    version: LAYOUT_VERSION,
    panes,
    tabs: tabs.map((tab) => ({
      id: tab.id,
      title: tab.title,
      color: tab.color,
      pinned: tab.pinned,
      focused_pane: tab.focusedPane,
      root: nodeToJson(tab.root),
    })),
    active_tab: tabs.some((tab) => tab.id === state.activeTab) ? state.activeTab : (tabs[0]?.id ?? null),
    sidebar: { width: state.sidebar.width, hidden: state.sidebar.hidden },
    right_panel: { open: state.rightPanel.open, width: state.rightPanel.width },
  };
}

class ParseError extends Error {}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isId = (value: unknown): value is string => typeof value === "string" && value.trim() !== "";

const MAX_DEPTH = 32;

export interface ParseOptions {
  /** Ids for split nodes (the JSON has none). */
  newId?: IdGenerator;
  /** The cwd panes start with until their session reports one. */
  cwd?: string;
}

/** Parses §5.3 JSON (a string or an already parsed value). */
export function parseLayout(input: unknown, options: ParseOptions = {}): ParseResult {
  const newId = options.newId ?? createIdGenerator();
  const repairs: string[] = [];
  try {
    let data = input;
    if (typeof input === "string") {
      try {
        data = JSON.parse(input);
      } catch {
        throw new ParseError("not valid JSON");
      }
    }
    if (!isRecord(data)) throw new ParseError("the layout is not an object");
    if (!Array.isArray(data.tabs)) throw new ParseError("`tabs` is not an array");
    if (typeof data.version === "number" && data.version > LAYOUT_VERSION) {
      throw new ParseError(
        `the layout is version ${data.version}, newer than this Tessera understands (${LAYOUT_VERSION})`,
      );
    }
    const savedPanes = isRecord(data.panes) ? data.panes : {};

    const seen = new Set<string>();
    const claim = (id: string, what: string) => {
      if (seen.has(id)) throw new ParseError(`duplicate ${what} id "${id}"`);
      seen.add(id);
    };

    const parseNode = (value: unknown, depth: number): LayoutNode => {
      if (depth > MAX_DEPTH) throw new ParseError("the split tree is too deep");
      if (!isRecord(value)) throw new ParseError("a node is not an object");
      if ("pane" in value) {
        if (!isId(value.pane)) throw new ParseError("a pane has no id");
        claim(value.pane, "pane");
        let kind = value.kind as PaneKind;
        if (!PANE_KINDS.includes(kind)) {
          repairs.push(`pane ${value.pane}: unknown kind, using "shell"`);
          kind = "shell";
        }
        const sessionId = typeof value.session_id === "string" ? value.session_id : null;
        return { type: "pane", id: value.pane, sessionId, kind };
      }
      if ("split" in value) {
        if (value.split !== "row" && value.split !== "col") throw new ParseError("a split is neither row nor col");
        if (!Array.isArray(value.children) || value.children.length === 0) {
          throw new ParseError("a split has no children");
        }
        const children = value.children.map((child) => parseNode(child, depth + 1));
        const ratios = Array.isArray(value.ratios) ? value.ratios.map(Number) : [];
        return { type: "split", id: newId(), direction: value.split, ratios, children };
      }
      throw new ParseError("a node is neither a pane nor a split");
    };

    const panes: Record<PaneId, PaneInfo> = {};
    const tabs: Tab[] = data.tabs.map((value: unknown): Tab => {
      if (!isRecord(value)) throw new ParseError("a tab is not an object");
      if (!isId(value.id)) throw new ParseError("a tab has no id");
      claim(value.id, "tab");
      const parsed = parseNode(value.root, 0);
      const root = normalizeNode(parsed);
      if (JSON.stringify(nodeToJson(root)) !== JSON.stringify(nodeToJson(parsed))) {
        repairs.push(`tab ${value.id}: split tree normalized`);
      }
      const ids = paneIds(root);
      for (const id of ids) {
        const saved = savedPanes[id];
        const cwd =
          isRecord(saved) && typeof saved.cwd === "string" && saved.cwd !== "" ? saved.cwd : (options.cwd ?? "");
        const taskId =
          isRecord(saved) && typeof saved.task_id === "string" && saved.task_id !== "" ? saved.task_id : undefined;
        panes[id] = { cwd, programTitle: null, runningProcess: null, ...(taskId ? { taskId } : {}) };
      }
      let focusedPane = value.focused_pane;
      if (!isId(focusedPane) || !ids.includes(focusedPane)) {
        repairs.push(`tab ${value.id}: focused pane missing, focusing the first pane`);
        focusedPane = ids[0];
      }
      const title = typeof value.title === "string" && value.title.trim() ? value.title.trim() : null;
      const color = TAB_COLORS.includes(value.color as TabColor) ? (value.color as TabColor) : null;
      if (value.color !== null && value.color !== undefined && color === null) {
        repairs.push(`tab ${value.id}: unknown colour dropped`);
      }
      return {
        id: value.id,
        title,
        color,
        pinned: value.pinned === true,
        root,
        focusedPane: focusedPane as PaneId,
        zoomedPane: null,
      };
    });

    // Pinned tabs first, keeping their order.
    const ordered = [...tabs.filter((tab) => tab.pinned), ...tabs.filter((tab) => !tab.pinned)];
    if (ordered.some((tab, i) => tab !== tabs[i])) repairs.push("pinned tabs moved before the others");

    let activeTab = typeof data.active_tab === "string" ? data.active_tab : null;
    if (!ordered.some((tab) => tab.id === activeTab)) {
      if (ordered.length > 0) repairs.push("active tab missing, selecting the first tab");
      activeTab = ordered[0]?.id ?? null;
    }

    const sidebar = isRecord(data.sidebar) ? data.sidebar : {};
    const rightPanel = isRecord(data.right_panel) ? data.right_panel : {};
    const width = (value: unknown, limits: { min: number; default: number; max: number }) =>
      typeof value === "number" && Number.isFinite(value)
        ? Math.min(limits.max, Math.max(limits.min, Math.round(value)))
        : limits.default;

    const value: LayoutState = {
      tabs: ordered,
      activeTab,
      panes,
      sidebar: { width: width(sidebar.width, SIDEBAR_WIDTH), hidden: sidebar.hidden === true, overlayOpen: false },
      rightPanel: { open: rightPanel.open === true, width: width(rightPanel.width, RIGHT_PANEL_WIDTH) },
      closedTabs: [],
    };
    // Split ids are new; make sure none of them clashes with a tab or pane id from the file.
    for (const tab of value.tabs) for (const split of splitNodes(tab.root)) claim(split.id, "split");
    return { ok: true, value, repairs };
  } catch (error) {
    if (error instanceof ParseError) return { ok: false, error: error.message };
    return { ok: false, error: `unreadable layout (${error instanceof Error ? error.message : String(error)})` };
  }
}
