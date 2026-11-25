// The two destructive confirmations of the sidebar.
// - Delete task: a first confirmation; when the backend answers `UnmergedCommits{list}` the commits are listed and a
//   second, explicit button ("Delete and lose N commits") is required. Cancel has the focus in both steps.
// - Remove project: forgets the project and its tasks, never touches folders on disk.
// - Archive the other tasks of a best-of-N group once one is picked (M6.8): archiving keeps every file.
import { Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle, Icons, t } from "@tessera/ui";
import { useState } from "react";
import { archiveTaskAction, performDeleteTask } from "../sidebar/taskActions";
import { performRemoveProject } from "../sidebar/projectActions";
import { useAppDispatch, useAppSelector } from "../store/hooks";
import { errorTitleKey, type ProjectsError, mapProjectsError } from "./errors";
import type { CommitInfo } from "./types";

export function DeleteTaskDialog({ taskId, onClose }: { taskId: string; onClose: () => void }) {
  const dispatch = useAppDispatch();
  const task = useAppSelector((state) => state.projects.tasks[taskId]);
  const [commits, setCommits] = useState<CommitInfo[] | null>(null);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!task) return null;

  const run = async (confirmLost: boolean) => {
    setBusy(true);
    setError(null);
    try {
      await dispatch(performDeleteTask(taskId, confirmLost));
      onClose();
    } catch (cause) {
      const failure: ProjectsError = mapProjectsError(cause);
      if (failure.kind === "UnmergedCommits" && !confirmLost) {
        setCommits(failure.commits);
        setDirty(failure.extra.dirty === true);
      } else setError(failure.message || t(errorTitleKey(failure.kind)));
    } finally {
      setBusy(false);
    }
  };

  const unmerged = commits !== null;
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent hideClose role="alertdialog">
        <DialogTitle>
          {unmerged ? t("task.delete.unmergedTitle", { name: task.name }) : t("task.delete.title", { name: task.name })}
        </DialogTitle>
        <DialogDescription>
          {unmerged
            ? t("task.delete.unmergedBody", { count: commits.length })
            : task.uses_main_checkout
              ? t("task.delete.bodyMain")
              : task.keeps_branch
                ? t("task.delete.bodyKeeps", { branch: task.branch })
                : t("task.delete.body")}
        </DialogDescription>
        {unmerged && (
          <>
            <ul className="m-0 max-h-40 list-none overflow-auto rounded-md border border-border bg-surface-2 p-2 font-mono text-sm">
              {commits.map((commit) => (
                <li key={`${commit.hash}:${commit.subject}`} className="flex gap-2">
                  <span className="shrink-0 text-muted">{commit.hash.slice(0, 7)}</span>
                  <span className="min-w-0 break-words">{commit.subject}</span>
                </li>
              ))}
            </ul>
            {dirty && <p className="text-sm text-st-needs">{t("task.delete.dirty")}</p>}
          </>
        )}
        {error && (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        )}
        <DialogFooter>
          <Button autoFocus onClick={onClose}>
            {t("confirm.cancel")}
          </Button>
          <Button variant="danger" icon={Icons.Trash2} disabled={busy} onClick={() => void run(unmerged)}>
            {unmerged ? t("task.delete.confirmLose", { count: commits.length }) : t("task.delete.confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function RemoveProjectDialog({ projectId, onClose }: { projectId: string; onClose: () => void }) {
  const dispatch = useAppDispatch();
  const project = useAppSelector((state) => state.projects.projects[projectId]);
  const withWorktrees = useAppSelector(
    (state) =>
      Object.values(state.projects.tasks).filter((task) => task.project_id === projectId && task.worktree_path !== null)
        .length,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!project) return null;
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent hideClose role="alertdialog">
        <DialogTitle>{t("project.remove.title", { name: project.name })}</DialogTitle>
        <DialogDescription>
          {t("project.remove.body")}
          {withWorktrees > 0 && ` ${t("project.remove.worktrees", { count: withWorktrees })}`}
        </DialogDescription>
        {error && (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        )}
        <DialogFooter>
          <Button autoFocus onClick={onClose}>
            {t("confirm.cancel")}
          </Button>
          <Button
            variant="danger"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              dispatch(performRemoveProject(projectId)).then(onClose, (cause) => {
                setBusy(false);
                setError(mapProjectsError(cause).message);
              });
            }}
          >
            {t("project.remove.confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function ArchiveGroupOthersDialog({ groupId, onClose }: { groupId: string; onClose: () => void }) {
  const dispatch = useAppDispatch();
  const group = useAppSelector((state) => state.projects.groups[groupId]);
  const tasks = useAppSelector((state) => state.projects.tasks);
  const [busy, setBusy] = useState(false);
  if (!group?.picked_task_id) return null;
  const picked = tasks[group.picked_task_id];
  const others = Object.values(tasks).filter(
    (task) => task.group_id === groupId && task.id !== group.picked_task_id && !task.archived_at,
  );
  const archive = async () => {
    setBusy(true);
    try {
      for (const task of others) await dispatch(archiveTaskAction(task.id));
    } finally {
      setBusy(false);
      onClose();
    }
  };
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent hideClose role="alertdialog" data-archive-group-others>
        <DialogTitle>{t("taskGroup.archiveTitle", { count: others.length })}</DialogTitle>
        <DialogDescription>{t("taskGroup.archiveBody", { name: picked?.name ?? "" })}</DialogDescription>
        <DialogFooter>
          <Button autoFocus onClick={onClose}>
            {t("confirm.cancel")}
          </Button>
          <Button variant="danger" disabled={busy || others.length === 0} onClick={() => void archive()}>
            {t("taskGroup.archiveConfirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
