// The branches of a project's repository. Picking one makes it a task (in branch mode the folder switches to it; in
// worktree mode it gets a worktree). A branch that already has a task opens that task instead.
import { Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle, Icons, t } from "@tessera/ui";
import { useEffect, useState } from "react";
import { openTaskTab } from "../../sidebar/taskTabs";
import { useAppDispatch, useAppSelector } from "../../store/hooks";
import { mapProjectsError } from "../errors";
import { projectsClient } from "../service";
import { createTask } from "../thunks";

export function BranchesDialog({ projectId, onClose }: { projectId: string; onClose: () => void }) {
  const dispatch = useAppDispatch();
  const project = useAppSelector((state) => state.projects.projects[projectId]);
  const tasks = useAppSelector((state) => state.projects.tasks);
  const [branches, setBranches] = useState<string[] | null>(null);
  const [current, setCurrent] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [failure, setFailure] = useState<{ branch: string; message: string } | null>(null);
  const path = project?.path;
  useEffect(() => {
    if (!path) return;
    let live = true;
    void projectsClient()
      .gitBranches(path)
      .then((list) => live && setBranches(list))
      .catch(() => live && setBranches([]));
    void projectsClient()
      .repoInfo(path)
      .then((facts) => live && setCurrent(facts.branch))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [path]);
  if (!project) return null;

  const taskOn = (branch: string) =>
    Object.values(tasks).find(
      (task) => task.project_id === project.id && task.branch === branch && task.state !== "deleted",
    );
  const work = async (branch: string) => {
    setBusy(branch);
    setFailure(null);
    try {
      const result = await dispatch(
        createTask({
          project_id: project.id,
          name: branch.replace(/^remotes\/[^/]+\//, ""),
          base_branch: project.default_branch,
          existing_branch: branch,
          agents: [],
          use_main_checkout: false,
          run_setup: false,
        }),
      );
      const created = result.tasks[0];
      onClose();
      if (created) dispatch(openTaskTab(created.id));
    } catch (cause) {
      setFailure({ branch, message: mapProjectsError(cause).message });
    } finally {
      setBusy(null);
    }
  };
  const local = (branches ?? []).filter((entry) => !entry.startsWith("remotes/"));
  const remote = (branches ?? []).filter(
    (entry) => entry.startsWith("remotes/") && !local.includes(entry.replace(/^remotes\/[^/]+\//, "")),
  );
  const row = (branch: string) => {
    const task = taskOn(branch.replace(/^remotes\/[^/]+\//, ""));
    return (
      <li
        key={branch}
        data-branch-row={branch}
        className="flex flex-col gap-1 rounded-lg border border-border bg-surface-2 p-2"
      >
        <div className="flex items-center gap-2">
          <Icons.GitBranch size={14} className="shrink-0 text-muted" aria-hidden />
          <span className="min-w-0 flex-1 truncate font-medium">{branch}</span>
          {current === branch && <span className="text-xs text-muted">{t("branches.current")}</span>}
          {task ? (
            <Button
              size="sm"
              onClick={() => {
                onClose();
                dispatch(openTaskTab(task.id));
              }}
            >
              {t("branches.openTask")}
            </Button>
          ) : (
            <Button size="sm" icon={Icons.Plus} disabled={busy === branch} onClick={() => void work(branch)}>
              {t("branches.work")}
            </Button>
          )}
        </div>
        {failure?.branch === branch && (
          <p role="alert" className="m-0 text-sm text-st-error">
            {failure.message}
          </p>
        )}
      </li>
    );
  };

  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent data-branches-dialog>
        <DialogTitle>{t("branches.title", { name: project.name })}</DialogTitle>
        <DialogDescription>{t("branches.body")}</DialogDescription>
        {branches?.length === 0 && <p className="m-0 text-sm text-muted">{t("branches.empty")}</p>}
        <ul className="m-0 flex max-h-80 list-none flex-col gap-2 overflow-auto p-0">
          {local.map(row)}
          {remote.length > 0 && <li className="mt-1 text-xs font-medium text-muted">{t("branches.remote")}</li>}
          {remote.map(row)}
        </ul>
        <DialogFooter>
          <Button variant="primary" onClick={onClose}>
            {t("branches.ok")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
