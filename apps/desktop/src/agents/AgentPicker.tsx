// "Start agent in this task…": pick a profile of an installed agent and an optional prompt; the agent starts in the
// focused task's worktree (or the home folder in a new tab when no task is focused).
import { Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle, Select, t } from "@tessera/ui";
import { useEffect, useState } from "react";
import { Field, TextArea } from "../projects/dialogs/Field";
import { notifications } from "../notify";
import { currentTaskId } from "../sidebar/taskTabs";
import { useAppDispatch, useAppSelector } from "../store/hooks";
import { store } from "../store";
import { agentsErrorMessage } from "./errors";
import { agentLaunchToast, startAgent } from "./launch";
import { setAgentPicker } from "./sessionsSlice";
import { launchableLabel, useLaunchable } from "./useLaunchable";

export function AgentPicker() {
  const open = useAppSelector((state) => state.agentSessions.pickerOpen);
  const dispatch = useAppDispatch();
  const { items, loading } = useLaunchable(open);
  const [profileId, setProfileId] = useState("");
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open && !items.some((item) => item.profile.id === profileId)) setProfileId(items[0]?.profile.id ?? "");
  }, [open, items, profileId]);

  const close = () => {
    dispatch(setAgentPicker(false));
    setPrompt("");
    setBusy(false);
  };

  const start = async () => {
    if (!profileId) return;
    setBusy(true);
    try {
      const plan = await dispatch(
        startAgent({
          profileId,
          prompt: prompt.trim() ? prompt : null,
          taskId: currentTaskId(store.getState()),
          cwd: null,
        }),
      );
      agentLaunchToast(plan);
      close();
    } catch (cause) {
      notifications().toastNow({
        kind: "error",
        title: t("agents.launch.failed", { message: agentsErrorMessage(cause) }),
      });
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !next && !busy && close()}>
      <DialogContent data-agent-picker>
        <DialogTitle>{t("agents.pick.title")}</DialogTitle>
        <DialogDescription>{t("agents.pick.description")}</DialogDescription>
        {!loading && items.length === 0 ? (
          <p className="text-sm text-muted">{t("agents.pick.none")}</p>
        ) : (
          <div className="flex flex-col gap-3">
            <Select
              aria-label={t("agents.pick.title")}
              value={profileId}
              onValueChange={setProfileId}
              options={items.map((item) => ({ value: item.profile.id, label: launchableLabel(item) }))}
            />
            <Field label={t("agents.pick.prompt")}>
              {({ id, describedBy }) => (
                <TextArea
                  id={id}
                  aria-describedby={describedBy}
                  value={prompt}
                  onChange={(event) => setPrompt(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) void start();
                  }}
                />
              )}
            </Field>
          </div>
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={close} disabled={busy}>
            {t("form.cancel")}
          </Button>
          <Button variant="primary" onClick={() => void start()} disabled={busy || !profileId}>
            {t("agents.pick.start")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
