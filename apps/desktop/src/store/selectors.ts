// Memoised selectors (createSelector): components re-render only when what they show changes.
import { createSelector } from "@reduxjs/toolkit";
import { activeTabOf, focusedPaneInfo, type Tab, tabTitle } from "../layout";
import type { RootState } from ".";

export const selectLayout = (state: RootState) => state.layout;
export const selectTabs = (state: RootState) => state.layout.tabs;
export const selectActiveTabId = (state: RootState) => state.layout.activeTab;
export const selectPanes = (state: RootState) => state.layout.panes;
export const selectSidebar = (state: RootState) => state.layout.sidebar;
export const selectClosedTabCount = (state: RootState) => state.layout.closedTabs.length;

export const selectActiveTab = createSelector([selectLayout], (layout): Tab | null => activeTabOf(layout) ?? null);

/** Each tab's shown title (null: the UI uses the catalog fallback). */
export const selectTabTitles = createSelector([selectTabs, selectPanes], (tabs, panes) => {
  const titles: Record<string, string | null> = {};
  for (const tab of tabs) titles[tab.id] = tabTitle({ panes }, tab);
  return titles;
});

export const selectFocusedCwd = createSelector([selectLayout], (layout) => focusedPaneInfo(layout)?.cwd ?? null);
