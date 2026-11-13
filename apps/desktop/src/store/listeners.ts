// Side effects of layout changes, in the listener middleware (no logic in components):
// - focus return: after a split, a close, a new or reopened tab, a tab switch by shortcut, a focus move or a zoom,
//   keyboard focus belongs in the focused pane (or, after a change made in the tab strip, on the selected tab);
// - a tab moved with the keyboard is announced in the live region and keeps the focus;
// - a pane's badge clears once the user looks at the pane (window focused, pane focused and on screen), and a closed
//   pane's progress and badge are forgotten.
import { isAnyOf, type TypedStartListening } from "@reduxjs/toolkit";
import { t } from "@tessera/ui";
import { paneRemoved } from "../agents/launch";
import { activeTabOf, type LayoutAction, tabTitle } from "../layout";
import type { AppDispatch, RootState } from ".";
import { agentAttentionEffect } from "../agents/attentionEngine";
import { sessionUpserted } from "../agents/sessionsSlice";
import { clearAgentAttention, clearBadge, forgetPane } from "./attentionSlice";
import { layout } from "./layoutSlice";
import { setTerminal, zoomFont } from "./settingsSlice";
import { announce, requestPaneFocus, setWindowFocused } from "./uiSlice";

/** Layout changes after which keyboard focus moves into the focused pane. */
export const FOCUS_PANE_AFTER = new Set<LayoutAction["type"]>([
  "tab/new",
  "tab/close",
  "tab/closeOthers",
  "tab/selectIndex",
  "tab/selectRelative",
  "tab/reopen",
  "pane/split",
  "pane/close",
  "pane/focusDirection",
  "pane/zoomToggle",
]);

/** Focuses the selected tab in the tab strip once React has rendered. Does nothing outside a browser. */
function focusSelectedTab(state: RootState): void {
  const id = state.layout.activeTab;
  if (!id || typeof document === "undefined") return;
  requestAnimationFrame(() => document.getElementById(`tab-${id}`)?.focus());
}

/** The pane the user is looking at: the focused pane of the active tab while the window has the focus. */
export function lookedAtPane(state: RootState): string | null {
  if (!state.ui.windowFocused) return null;
  const tab = activeTabOf(state.layout);
  if (!tab || (tab.zoomedPane !== null && tab.zoomedPane !== tab.focusedPane)) return null;
  return tab.focusedPane;
}

export function addAppListeners(startListening: TypedStartListening<RootState, AppDispatch>): void {
  startListening({
    predicate: (action) => layout.match(action) || setWindowFocused.match(action),
    effect: (_action, api) => {
      const state = api.getState();
      const looked = lookedAtPane(state);
      if (looked && state.attention.badges[looked]) api.dispatch(clearBadge(looked));
      if (looked && state.attention.agentAttention[looked]) {
        api.dispatch(clearAgentAttention({ paneId: looked }));
      }
      for (const paneId of new Set([
        ...Object.keys(state.attention.badges),
        ...Object.keys(state.attention.progress),
      ])) {
        if (!state.layout.panes[paneId]) api.dispatch(forgetPane(paneId));
      }
      // An agent pane that left the layout (closed, its tab closed, a restore) ends its session and delivery.
      for (const paneId of Object.keys(api.getState().agentSessions.launches)) {
        if (!api.getState().layout.panes[paneId]) api.dispatch(paneRemoved(paneId));
      }
    },
  });

  // Font zoom and the ligatures toggle are announced in the live region (they change the whole terminal at once).
  startListening({
    matcher: isAnyOf(zoomFont, setTerminal),
    effect: (_action, api) => {
      const before = api.getOriginalState().settings.terminal;
      const after = api.getState().settings.terminal;
      if (after.fontSize !== before.fontSize) api.dispatch(announce(t("terminal.fontSize", { size: after.fontSize })));
      if (after.ligatures !== before.ligatures) {
        api.dispatch(announce(t(after.ligatures ? "terminal.ligaturesOn" : "terminal.ligaturesOff")));
      }
    },
  });

  // Agent status → attention (brief 32): needs_input, or idle after working, while the pane is not looked at.
  startListening({
    actionCreator: sessionUpserted,
    effect: (action, api) => {
      const previous = api.getOriginalState().agentSessions.sessions[action.payload.id];
      agentAttentionEffect(action.payload, previous, api);
    },
  });

  startListening({
    actionCreator: layout,
    effect: (action, api) => {
      const change = action.payload;
      const focus = action.meta?.focus ?? (FOCUS_PANE_AFTER.has(change.type) ? "pane" : "none");
      if (focus === "pane") api.dispatch(requestPaneFocus());
      if (focus === "tab") focusSelectedTab(api.getState());

      if (change.type === "tab/move") {
        const state = api.getState();
        const tab = activeTabOf(state.layout);
        if (!tab) return;
        api.dispatch(
          announce(
            t("tab.moved", {
              title: tabTitle(state.layout, tab) ?? t("tab.untitled"),
              position: state.layout.tabs.indexOf(tab) + 1,
              count: state.layout.tabs.length,
            }),
          ),
        );
        focusSelectedTab(state);
      }
    },
  });
}
