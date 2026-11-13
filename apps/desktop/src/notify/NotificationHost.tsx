// Window-level attention, mounted once in the Shell:
// - tracks whether the window has the OS focus (ui.windowFocused);
// - hands the toast function to the NotificationService and shows its permission explanation;
// - keeps the window title on the active tab's title (OSC 0/2 through the tab title rules);
// - sends the combined progress of all panes to the ProgressSink (dock, taskbar).
import { Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle, t, useToast } from "@tessera/ui";
import { useEffect, useMemo } from "react";
import { createProgressSink } from "../native/progress";
import { setWindowTitle, watchWindowFocus } from "../native/window";
import { reportNativeCommandError } from "../native/errors";
import { combineProgress } from "../store/attentionSlice";
import { setAttentionCount } from "../native/attention";
import { useAppDispatch, useAppSelector } from "../store/hooks";
import { selectActiveTabId, selectTabTitles } from "../store/selectors";
import { requestPaneFocus, setWindowFocused } from "../store/uiSlice";
import { notifications } from ".";

export function NotificationHost() {
  const dispatch = useAppDispatch();
  const { toast } = useToast();
  const prompt = useAppSelector((state) => state.ui.notificationPrompt);
  const activeTab = useAppSelector(selectActiveTabId);
  const titles = useAppSelector(selectTabTitles);
  const progress = useAppSelector((state) => state.attention.progress);
  const attentionCount = useAppSelector(
    (state) => new Set([...Object.keys(state.attention.agentAttention), ...Object.keys(state.attention.badges)]).size,
  );
  const sink = useMemo(() => createProgressSink(), []);

  useEffect(() => watchWindowFocus((focused) => dispatch(setWindowFocused(focused))), [dispatch]);

  useEffect(() => {
    const service = notifications();
    service.setToaster((options) => toast(options));
    return () => service.setToaster(null);
  }, [toast]);

  const title = activeTab ? (titles[activeTab] ?? t("tab.untitled")) : null;
  useEffect(() => {
    void setWindowTitle(title ? `${title} — ${t("app.name")}` : t("app.name"));
  }, [title]);

  const combined = useMemo(() => combineProgress(Object.values(progress)), [progress]);
  const key = combined ? `${combined.state}:${combined.value}` : "none";
  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` stands for `combined`'s content.
  useEffect(() => {
    void sink.set(combined).catch((error: unknown) => reportNativeCommandError("native.progressFailed", error));
  }, [key, sink]);

  // Dock badge / taskbar overlay: the number of panes that need the user (agent attention + badges).
  useEffect(() => {
    void setAttentionCount(attentionCount).catch(() => {});
  }, [attentionCount]);

  return (
    <Dialog open={prompt} onOpenChange={(open) => !open && void notifications().answerPrompt(false)}>
      <DialogContent
        hideClose
        role="alertdialog"
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          dispatch(requestPaneFocus());
        }}
      >
        <DialogTitle>{t("notify.permission.title")}</DialogTitle>
        <DialogDescription>{t("notify.permission.body")}</DialogDescription>
        <DialogFooter>
          <Button onClick={() => void notifications().answerPrompt(false)}>{t("notify.permission.later")}</Button>
          <Button variant="primary" onClick={() => void notifications().answerPrompt(true)}>
            {t("notify.permission.allow")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
