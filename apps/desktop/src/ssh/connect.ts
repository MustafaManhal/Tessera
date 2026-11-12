// Opening a terminal on an SSH host: the plan from Rust, then a new tab whose `ssh` pane spawns it like any terminal
// (PaneInfo.launch, as agent panes do). A saved password reaches ssh through SSH_ASKPASS, never through this code.
import { t } from "@tessera/ui";
import { activeTabOf } from "../layout";
import { notifications } from "../notify";
import type { AppThunk } from "../store";
import { layout } from "../store/layoutSlice";
import { announce } from "../store/uiSlice";
import { sshClient } from "./service";

export const connectSsh =
  (hostId: string): AppThunk<Promise<void>> =>
  async (dispatch, getState) => {
    let plan: Awaited<ReturnType<ReturnType<typeof sshClient>["connectPlan"]>>;
    try {
      plan = await sshClient().connectPlan(hostId);
    } catch (cause) {
      notifications().toastNow({
        kind: "error",
        title: t("ssh.connectFailed", { message: cause instanceof Error ? cause.message : String(cause) }),
      });
      return;
    }
    dispatch(layout({ type: "tab/new", kind: "ssh", title: plan.title }));
    const tab = activeTabOf(getState().layout);
    if (!tab) return;
    dispatch(
      layout({
        type: "pane/setLaunch",
        paneId: tab.focusedPane,
        launch: { program: plan.program, args: plan.args, env: plan.env },
      }),
    );
    dispatch(announce(t("ssh.connecting", { name: plan.title })));
    if (plan.notice) notifications().toastNow({ title: plan.notice });
  };
