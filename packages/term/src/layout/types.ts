// Layout model (TRD §4.4): a window holds tabs; each tab holds a split tree of panes. The JSON form persisted in
// `layouts.state` (05-backend-schema §5.3) is in serialize.ts; this is the in-memory form the reducer works on.

export type TabId = string;
export type PaneId = string;
export type SplitId = string;

/** What runs in a pane (`pane_sessions.kind`). */
export const PANE_KINDS = ["shell", "agent", "run", "setup", "ssh"] as const;
export type PaneKind = (typeof PANE_KINDS)[number];

/** `row`: children side by side (made by "split right"); `col`: children stacked (made by "split down"). */
export type SplitDirection = "row" | "col";

export type Direction = "left" | "right" | "up" | "down";

/** Tab colours are names, not hex values, so a saved layout follows the theme. Each has a token in tokens.css. */
export const TAB_COLORS = ["red", "orange", "yellow", "green", "blue", "purple"] as const;
export type TabColor = (typeof TAB_COLORS)[number];

export interface PaneNode {
  type: "pane";
  id: PaneId;
  /** The PTY session shown in the pane; null until the pane has started one (M1). */
  sessionId: string | null;
  kind: PaneKind;
}

export interface SplitNode {
  type: "split";
  /** In memory only (the JSON has no split ids): lets the view address a divider. */
  id: SplitId;
  direction: SplitDirection;
  /** One share per child, each in (0, 1), summing to 1. */
  ratios: number[];
  /** Two or more children; never a split in the same direction (it is flattened into this one). */
  children: LayoutNode[];
}

export type LayoutNode = PaneNode | SplitNode;

export interface Tab {
  id: TabId;
  /** The manual title. Set, it is locked; null, the title follows the program title or the cwd (FR-25). */
  title: string | null;
  color: TabColor | null;
  pinned: boolean;
  root: LayoutNode;
  focusedPane: PaneId;
  /** The pane filling the tab, or null. Not persisted. */
  zoomedPane: PaneId | null;
}

/** Runtime state a pane's content reports (cwd from OSC 7, title from OSC 0/2, a running foreground process). */
export interface PaneInfo {
  cwd: string;
  programTitle: string | null;
  /** Name of a foreground process that closing the pane would stop, e.g. "npm run dev"; null when idle. */
  runningProcess: string | null;
  /** The task this pane belongs to (a task tab and its splits); absent for plain terminals. */
  taskId?: string;
  /** A fixed name, such as a run script's: it wins over the program title. Not saved with the layout. */
  name?: string;
  /** Runtime-only handoff information. Saved layouts omit it. */
  transfer?: { id: string; pending?: boolean; sessionId?: string; exitCode?: number };
  /** How an agent pane starts its program (runtime only; saved layouts omit it). */
  launch?: { program: string; args: string[]; env: Record<string, string> };
  /** Bumped when an agent restarts in the same pane, to make the terminal spawn again (runtime only). */
  restartKey?: number;
}

/** A closed tab kept for "Reopen closed tab". */
export interface ClosedTab {
  tab: Tab;
  /** Where it was, to put it back there. */
  index: number;
  panes: Record<PaneId, PaneInfo>;
}

export interface SidebarState {
  width: number;
  hidden: boolean;
  /** In a narrow window the sidebar opens over the panes instead; not persisted. */
  overlayOpen: boolean;
}

export interface LayoutState {
  tabs: Tab[];
  /** The selected tab; null only when there are no tabs. */
  activeTab: TabId | null;
  panes: Record<PaneId, PaneInfo>;
  sidebar: SidebarState;
  rightPanel: { open: boolean; width: number };
  /** Most recent last; at most CLOSED_TABS_MAX. Not persisted. */
  closedTabs: ClosedTab[];
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A divider between two children of a split, for the view and for keyboard resizing. */
export interface Divider {
  splitId: SplitId;
  /** The divider sits between child `index` and child `index + 1`. */
  index: number;
  /** `row`: a vertical line (drag left and right); `col`: a horizontal line. */
  direction: SplitDirection;
  /** Position of the line: `x` for a row split, `y` for a col split; the other two give its extent. */
  x: number;
  y: number;
  length: number;
  /** The rect of the whole split, so a drag can turn pixels into a ratio. */
  splitRect: Rect;
  /** Share of the split taken by the children before the divider (0–1): `aria-valuenow` / 100. */
  position: number;
}

/** Limits from 03-UI-UX §3 and the store. */
export const SIDEBAR_WIDTH = { min: 200, default: 260, max: 420 } as const;
export const RIGHT_PANEL_WIDTH = { min: 360, default: 420, max: 720 } as const;
export const CLOSED_TABS_MAX = 10;
/** Smallest share of a split one child keeps when resized, unless the action passes its own (from pixels). */
export const MIN_RATIO = 0.1;
