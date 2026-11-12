// Tells the user what the start-up restore did, once: "Restored 3 tabs" with Undo (start fresh), or why the last session
// could not be restored. Mounted in the Shell.
import { t, useToast } from "@tessera/ui";
import { useEffect } from "react";
import { createLayout } from "../layout";
import { useAppStore } from "../store/hooks";
import { INITIAL_CWD, layout } from "../store/layoutSlice";
import { flushLayout, takeRestoreNotice } from "./service";

export function RestoreHost() {
  const { toast } = useToast();
  const store = useAppStore();
  useEffect(() => {
    const notice = takeRestoreNotice();
    if (!notice) return;
    if (notice.kind === "restored") {
      toast({
        title: notice.tabs === 1 ? t("restore.doneOne") : t("restore.done", { count: notice.tabs }),
        onUndo: () => {
          store.dispatch(layout({ type: "layout/replace", state: createLayout(INITIAL_CWD) }, "pane"));
          flushLayout();
        },
      });
    } else if (notice.kind === "failed") {
      toast({ kind: "error", title: t("restore.failed", { reason: notice.reason }) });
    }
  }, [toast, store]);
  return null;
}
