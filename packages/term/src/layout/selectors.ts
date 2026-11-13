// Read-only views of the layout state for the UI and the action registry.
import { activeTabOf, tabOfPane } from "./reducer";
import { findPane, paneIds } from "./tree";
import type { LayoutState, PaneId, PaneInfo, PaneNode, Tab } from "./types";

export { activeTabOf, tabOfPane };
export { neighbor, paneRects } from "./geometry";

/** The focused pane of the active tab, or null when there are no tabs. */
export function focusedPane(state: LayoutState): PaneNode | null {
  const tab = activeTabOf(state);
  return tab ? findPane(tab.root, tab.focusedPane) : null;
}

export function focusedPaneInfo(state: LayoutState): PaneInfo | null {
  const pane = focusedPane(state);
  return pane ? (state.panes[pane.id] ?? null) : null;
}

/** Last part of a path: "/Users/me/shop-api" → "shop-api", "C:\\code\\web" → "web", "/" → "/". */
export function baseName(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  if (trimmed === "") return path.startsWith("/") ? "/" : "";
  const parts = trimmed.split(/[\\/]/);
  return parts.at(-1) ?? trimmed;
}

/**
 * The title a tab shows (FR-25): the locked manual title, else the focused pane's program title, else its cwd's
 * last folder. Null when there is nothing to show; the UI then uses a catalog fallback.
 */
export function tabTitle(state: Pick<LayoutState, "panes">, tab: Tab): string | null {
  if (tab.title) return tab.title;
  const info = state.panes[tab.focusedPane];
  if (info?.programTitle) return info.programTitle;
  const name = info ? baseName(info.cwd) : "";
  return name || null;
}

/** The pane's own title: its program title, else its cwd's last folder. */
export function paneTitle(info: PaneInfo | undefined): string | null {
  if (!info) return null;
  return info.name || info.programTitle || baseName(info.cwd) || null;
}

/** Foreground processes a tab would stop when closed (empty: nothing to confirm). */
export function runningProcesses(state: LayoutState, tab: Tab): string[] {
  return paneIds(tab.root).flatMap((id) => {
    const process = state.panes[id]?.runningProcess;
    return process ? [process] : [];
  });
}

export function paneCount(tab: Tab): number {
  return paneIds(tab.root).length;
}

export function isPaneVisible(state: LayoutState, paneId: PaneId): boolean {
  const tab = tabOfPane(state, paneId);
  if (!tab || tab.id !== state.activeTab) return false;
  return tab.zoomedPane === null || tab.zoomedPane === paneId;
}
