// Hand a task to a different agent (M9.6, FR-45): choose agent + profile, edit the generated summary, and start the
// new agent in the same worktree with the summary as its prompt. The first agent is left running.
import { Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle, Select, t } from "@tessera/ui";
import { useEffect, useState } from "react";
import { launchableLabel, useLaunchable } from "../agents/useLaunchable";
import { agentsErrorMessage } from "../agents/errors";
import { startAgent } from "../agents/launch";
import { Field, FormError, TextArea } from "../projects/dialogs/Field";
import { useAppDispatch } from "../store/hooks";
import { announce } from "../store/uiSlice";
import { usageClient } from "./service";

export function HandoffDialog({
  taskId,
  currentAgentId,
  onClose,
}: {
  taskId: string;
  currentAgentId: string;
  onClose: () => void;
}) {
  const dispatch = useAppDispatch();
  const { items, loading } = useLaunchable();
  const [choice, setChoice] = useState<string>("");
  const [summary, setSummary] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    usageClient()
      .handoffSummary(taskId)
      .then((text) => alive && setSummary(text))
      .catch((cause) => alive && setError(agentsErrorMessage(cause)));
    return () => {
      alive = false;
    };
  }, [taskId]);

  // Other agents first: handing a task to the same agent is allowed but is not the point.
  const others = items.filter((item) => item.agent.id !== currentAgentId);
  const options = (others.length > 0 ? others : items).map((item) => ({
    value: item.profile.id,
    label: launchableLabel(item),
  }));
  useEffect(() => {
    if (!choice && options[0]) setChoice(options[0].value);
  }, [choice, options]);

  const start = async () => {
    if (!choice || summary === null) return;
    setBusy(true);
    setError(null);
    try {
      await dispatch(startAgent({ profileId: choice, prompt: summary.trim() || null, taskId, cwd: null }));
      dispatch(announce(t("handoff.started")));
      onClose();
    } catch (cause) {
      setError(agentsErrorMessage(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent data-handoff-dialog>
        <DialogTitle>{t("handoff.title")}</DialogTitle>
        <DialogDescription>{t("handoff.body")}</DialogDescription>
        <Field label={t("handoff.agent")} error={!loading && options.length === 0 ? t("handoff.noAgent") : null}>
          {({ id }) => (
            <Select
              id={id}
              value={choice}
              onValueChange={setChoice}
              options={options}
              disabled={options.length === 0}
            />
          )}
        </Field>
        <Field label={t("handoff.summary")} hint={t("handoff.summaryHint")}>
          {({ id, describedBy }) => (
            <TextArea
              id={id}
              aria-describedby={describedBy}
              data-handoff-summary
              className="min-h-48 font-mono text-sm"
              value={summary ?? ""}
              disabled={summary === null}
              onChange={(event) => setSummary(event.target.value)}
            />
          )}
        </Field>
        <FormError message={error} />
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            {t("button.cancel")}
          </Button>
          <Button variant="primary" disabled={busy || !choice || summary === null} onClick={() => void start()}>
            {t("handoff.start")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
