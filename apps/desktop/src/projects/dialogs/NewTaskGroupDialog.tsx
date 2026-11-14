// New task group (FR-36, S-04 sibling): one prompt, N agent profiles, N worktrees under one group. Each task's
// agent starts with the prompt once its tab exists (same flow as New task).
import { Button, cn, Select, Dialog, DialogContent, DialogFooter, DialogTitle, Input, t } from "@tessera/ui";
import { useEffect, useMemo, useState } from "react";
import { startAgent } from "../../agents/launch";
import { agentsErrorMessage } from "../../agents/errors";
import { useLaunchable } from "../../agents/useLaunchable";
import { notifications } from "../../notify";
import { openTaskTab } from "../../sidebar/taskTabs";
import { useAppDispatch, useAppSelector } from "../../store/hooks";
import { announce } from "../../store/uiSlice";
import { projectsClient } from "../service";
import type { Task } from "../types";
import { ProjectsError } from "../errors";

export function NewTaskGroupDialog({ onClose }: { onClose: () => void }) {
  const dispatch = useAppDispatch();
  const projects = useAppSelector((state) => state.projects.projects);
  const order = useAppSelector((state) => state.projects.order);
  const [projectId, setProjectId] = useState<string>(order[0] ?? Object.keys(projects)[0] ?? "");
  const project = projects[projectId];
  const [name, setName] = useState("");
  const [prompt, setPrompt] = useState("");
  const [base, setBase] = useState("");
  const [baseTouched, setBaseTouched] = useState(false);
  const [branches, setBranches] = useState<string[]>([]);
  const [agentChoice, setAgentChoice] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const { items: launchable } = useLaunchable();

  useEffect(() => {
    if (!baseTouched && project) setBase(project.default_branch);
  }, [project, baseTouched]);
  useEffect(() => {
    if (!project) return;
    void projectsClient()
      .repoInfo(project.path)
      .then((facts) =>
        setBranches([
          ...new Set([facts.default_branch, facts.branch, project.default_branch].filter((b): b is string => !!b)),
        ]),
      )
      .catch(() => setBranches([project.default_branch]));
  }, [project]);

  const chosen = useMemo(
    () => launchable.filter((item) => item.profile.is_default || agentChoice.includes(item.profile.id)),
    [launchable, agentChoice],
  );
  const toggleAgent = (profileId: string) =>
    setAgentChoice((ids) => (ids.includes(profileId) ? ids.filter((id) => id !== profileId) : [...ids, profileId]));

  const create = async () => {
    if (!project || !prompt.trim() || chosen.length < 2 || !base.trim()) return;
    setBusy(true);
    setFailure(null);
    try {
      const client = projectsClient();
      const { group_id, tasks } = await client.taskGroupCreate({
        project_id: project.id,
        prompt: prompt.trim(),
        base_branch: base.trim(),
        name: name.trim() || "best-of-n",
        profile_ids: chosen.map((item) => item.profile.id),
      });
      void group_id;
      // profile_ids[i] belongs to tasks[i] — one agent per worktree.
      for (const [index, task] of (tasks as Task[]).entries()) {
        dispatch(openTaskTab(task.id));
        const item = chosen[index];
        if (!item) continue;
        try {
          await dispatch(startAgent({ profileId: item.profile.id, prompt: prompt.trim(), taskId: task.id, cwd: null }));
        } catch (cause) {
          notifications().toastNow({
            kind: "error",
            title: t("agents.launch.failed", { message: agentsErrorMessage(cause) }),
          });
        }
      }
      dispatch(announce(t("taskGroup.created")));
      onClose();
    } catch (cause) {
      setFailure(cause instanceof ProjectsError ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="w-[36rem] max-w-[calc(100vw-2rem)]" data-task-group-dialog>
        <DialogTitle>{t("taskGroup.title")}</DialogTitle>
        <div className="flex flex-col gap-3">
          <label className="flex flex-col gap-1 text-xs text-muted" htmlFor="group-project">
            {t("taskGroup.project")}
          </label>
          <Select
            id="group-project"
            value={projectId}
            onValueChange={(id) => {
              setProjectId(id);
              setBaseTouched(false);
            }}
            options={order.map((id) => ({ value: id, label: projects[id]?.name ?? id }))}
          />
          <label className="flex flex-col gap-1 text-xs text-muted" htmlFor="group-name">
            {t("taskGroup.name")}
          </label>
          <Input
            id="group-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t("taskGroup.nameHint")}
          />
          <label className="flex flex-col gap-1 text-xs text-muted" htmlFor="group-prompt">
            {t("taskGroup.prompt")}
          </label>
          <textarea
            id="group-prompt"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            rows={3}
            className="w-full resize-y rounded-md border border-border bg-term-bg px-2 py-1.5 text-sm text-fg outline-none focus:border-accent-ink"
          />
          <label className="flex flex-col gap-1 text-xs text-muted" htmlFor="group-base">
            {t("taskGroup.base")}
          </label>
          <Select
            id="group-base"
            value={base}
            onValueChange={(id) => {
              setBase(id);
              setBaseTouched(true);
            }}
            options={branches.map((b) => ({ value: b, label: b }))}
          />
          <fieldset className="flex flex-col gap-1">
            <legend className="text-xs text-muted">{t("taskGroup.agents")}</legend>
            {launchable.map((item) => {
              const on = chosen.includes(item);
              return (
                <button
                  key={item.profile.id}
                  type="button"
                  data-agent-chip={item.agent.id}
                  aria-pressed={on}
                  className={cn(
                    "flex items-center gap-2 rounded-md border px-2 py-1 text-start text-sm",
                    on ? "border-accent-ink bg-accent/15" : "border-border text-muted",
                  )}
                  onClick={() => toggleAgent(item.profile.id)}
                >
                  {item.agent.name}
                  {item.profile.is_default ? "" : ` · ${item.profile.name}`}
                </button>
              );
            })}
          </fieldset>
          {failure && <p className="text-sm text-danger">{failure}</p>}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            {t("button.cancel")}
          </Button>
          <Button
            variant="primary"
            disabled={busy || !project || !prompt.trim() || chosen.length < 2 || !base.trim()}
            onClick={() => void create()}
          >
            {t("taskGroup.create")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
