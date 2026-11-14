// The worktrees manager: every worktree of a project's repository, the project folder first. A worktree is a folder on
// this computer that git links to a branch; it is never sent to GitHub (only branches can be pushed). Each row says
// which branch and task it belongs to, whether the branch is on a remote, and offers what can be done with it: open a
// terminal, work on it as a task, move it, unlink it from its branch, delete it, or forget it when its folder is gone.
// Nothing here happens by itself.
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
  Icons,
  Input,
  t,
} from "@tessera/ui";
import { useCallback, useEffect, useState } from "react";
import { notifications } from "../../notify";
import { openTaskTab } from "../../sidebar/taskTabs";
import { useAppDispatch, useAppSelector } from "../../store/hooks";
import { layout } from "../../store/layoutSlice";
import { mapProjectsError } from "../errors";
import { projectsClient } from "../service";
import { createTask } from "../thunks";
import type { WorktreeDetail } from "../types";

const folderName = (path: string) => path.split(/[\\/]/).filter(Boolean).pop() ?? path;
const same = (a: string, b: string) => a.replace(/[\\/]+$/, "") === b.replace(/[\\/]+$/, "");

type Action = { kind: "delete" | "unlink" | "move"; path: string; dirty?: boolean };

export function ExistingWorktreesDialog({ projectId, onClose }: { projectId: string; onClose: () => void }) {
  const dispatch = useAppDispatch();
  const project = useAppSelector((state) => state.projects.projects[projectId]);
  const tasks = useAppSelector((state) => state.projects.tasks);
  const [list, setList] = useState<WorktreeDetail[] | null>(null);
  const [action, setAction] = useState<Action | null>(null);
  const [target, setTarget] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [failure, setFailure] = useState<{ path: string; message: string } | null>(null);
  const path = project?.path;

  const reload = useCallback(async () => {
    if (!path) return;
    try {
      setList(await projectsClient().worktreeDetails(path));
    } catch {
      setList([]);
    }
  }, [path]);
  useEffect(() => {
    void reload();
  }, [reload]);
  if (!project) return null;

  const taskAt = (entry: WorktreeDetail) =>
    Object.values(tasks).find(
      (task) =>
        task.project_id === project.id &&
        task.state !== "deleted" &&
        (entry.is_main
          ? task.worktree_path === null && !!entry.branch && task.branch === entry.branch
          : !!task.worktree_path && same(task.worktree_path, entry.path)),
    );

  const run = async (entry: WorktreeDetail, work: () => Promise<void>) => {
    setBusy(entry.path);
    setFailure(null);
    try {
      await work();
      setAction(null);
      await reload();
    } catch (cause) {
      const message = mapProjectsError(cause).message;
      // Git refuses a worktree with changes unless forced: say so and offer the forced delete.
      if (action?.kind === "delete" && !action.dirty && /modified|untracked|changes|dirty|contains/i.test(message))
        setAction({ kind: "delete", path: entry.path, dirty: true });
      else setFailure({ path: entry.path, message });
    } finally {
      setBusy(null);
    }
  };

  const open = (entry: WorktreeDetail) => {
    dispatch(layout({ type: "tab/new", cwd: entry.path, title: folderName(entry.path) }));
    onClose();
  };
  const work = (entry: WorktreeDetail) =>
    run(entry, async () => {
      const existing = taskAt(entry);
      if (existing) {
        onClose();
        dispatch(openTaskTab(existing.id));
        return;
      }
      if (!entry.branch) return;
      const result = await dispatch(
        createTask({
          project_id: project.id,
          name: folderName(entry.path),
          base_branch: project.default_branch,
          existing_branch: entry.branch,
          agents: [],
          use_main_checkout: false,
          run_setup: false,
        }),
      );
      const created = result.tasks[0];
      if (created) {
        notifications().toastNow({ title: t("worktrees.existing.restored", { name: created.name }) });
        onClose();
        dispatch(openTaskTab(created.id));
      }
    });

  const badge = (text: string, tone: "muted" | "warn" = "muted", key?: string) => (
    <span
      key={key ?? text}
      className={`rounded-sm px-1.5 py-0.5 text-xs ${tone === "warn" ? "bg-st-needs-tint text-st-needs" : "bg-surface-3 text-muted"}`}
    >
      {text}
    </span>
  );

  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-w-2xl" data-existing-worktrees>
        <DialogTitle>{t("worktrees.existing.title", { name: project.name })}</DialogTitle>
        <DialogDescription>{t("worktrees.existing.body")}</DialogDescription>
        {list?.length === 0 && <p className="m-0 text-sm text-muted">{t("worktrees.existing.empty")}</p>}
        <ul className="m-0 flex max-h-96 list-none flex-col gap-2 overflow-auto overscroll-contain p-0">
          {(list ?? []).map((entry) => {
            const task = taskAt(entry);
            const asking = action?.path === entry.path ? action : null;
            return (
              <li
                key={entry.path}
                data-existing-worktree={entry.path}
                className="flex flex-col gap-2 rounded-lg border border-border bg-surface-2 p-2"
              >
                <div className="flex items-start gap-2">
                  <Icons.GitBranch size={14} className="mt-1 shrink-0 text-muted" aria-hidden />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">
                      {entry.branch ?? (entry.detached ? t("worktrees.existing.detached") : "—")}
                      {entry.head && <span className="ms-2 font-mono text-xs text-muted">{entry.head}</span>}
                    </span>
                    <span className="block truncate font-mono text-xs text-muted" title={entry.path}>
                      {entry.path}
                    </span>
                    <span className="mt-1 flex flex-wrap gap-1">
                      {entry.is_main && badge(t("worktrees.existing.main"))}
                      {task && badge(t("worktrees.existing.task", { name: task.name }), "muted", "task")}
                      {entry.branch &&
                        (entry.remote_branch
                          ? badge(t("worktrees.existing.pushed", { remote: entry.remote_branch }), "muted", "remote")
                          : badge(t("worktrees.existing.localOnly"), "muted", "remote"))}
                      {entry.dirty && badge(t("worktrees.existing.dirty"), "warn")}
                      {entry.missing && badge(t("worktrees.existing.missing"), "warn")}
                      {entry.locked !== null && badge(t("worktrees.existing.locked"))}
                    </span>
                  </span>
                </div>
                {asking?.kind === "move" ? (
                  <div className="flex flex-col gap-2" data-worktree-move>
                    <Input
                      aria-label={t("worktrees.existing.moveTo")}
                      value={target}
                      placeholder={t("worktrees.existing.moveTo")}
                      onChange={(event) => setTarget(event.target.value)}
                    />
                    <div className="flex flex-wrap gap-2">
                      <Button
                        size="sm"
                        variant="primary"
                        disabled={busy === entry.path || target.trim() === ""}
                        onClick={() =>
                          void run(entry, () => projectsClient().worktreeMove(project.path, entry.path, target.trim()))
                        }
                      >
                        {t("worktrees.existing.moveConfirm")}
                      </Button>
                      <Button size="sm" onClick={() => setAction(null)}>
                        {t("worktrees.existing.cancel")}
                      </Button>
                    </div>
                  </div>
                ) : asking ? (
                  <div className="flex flex-col gap-2" data-worktree-ask>
                    <p className="m-0 text-sm">
                      {asking.kind === "unlink"
                        ? t("worktrees.existing.unlinkAsk")
                        : asking.dirty
                          ? t("worktrees.existing.deleteDirty")
                          : task
                            ? t("worktrees.existing.deleteTask", { name: task.name })
                            : t("worktrees.existing.deleteAsk")}
                    </p>
                    <div className="flex flex-wrap gap-2">
                      <Button
                        size="sm"
                        variant={asking.kind === "delete" ? "danger" : "primary"}
                        disabled={busy === entry.path}
                        onClick={() =>
                          void run(entry, () =>
                            asking.kind === "unlink"
                              ? projectsClient().worktreeUnlink(project.path, entry.path)
                              : projectsClient().worktreeRemove(project.path, entry.path, !!asking.dirty),
                          )
                        }
                      >
                        {asking.kind === "unlink"
                          ? t("worktrees.existing.unlinkConfirm")
                          : asking.dirty
                            ? t("worktrees.existing.deleteForce")
                            : t("worktrees.existing.deleteConfirm")}
                      </Button>
                      <Button size="sm" onClick={() => setAction(null)}>
                        {t("worktrees.existing.cancel")}
                      </Button>
                    </div>
                  </div>
                ) : (
                  <div className="flex flex-wrap gap-2">
                    {entry.missing ? (
                      <Button
                        size="sm"
                        icon={Icons.Trash2}
                        disabled={busy === entry.path}
                        onClick={() => void run(entry, () => projectsClient().worktreePrune(project.path))}
                      >
                        {t("worktrees.existing.forget")}
                      </Button>
                    ) : (
                      <>
                        <Button size="sm" icon={Icons.SquareTerminal} onClick={() => open(entry)}>
                          {t("worktrees.existing.open")}
                        </Button>
                        {(task || entry.branch) && (
                          <Button
                            size="sm"
                            icon={Icons.Plus}
                            disabled={busy === entry.path}
                            onClick={() => void work(entry)}
                          >
                            {task ? t("worktrees.existing.openTask") : t("worktrees.existing.restore")}
                          </Button>
                        )}
                        {!entry.is_main && (
                          <>
                            <Button
                              size="sm"
                              icon={Icons.FolderOpen}
                              onClick={() => {
                                setTarget(entry.path);
                                setAction({ kind: "move", path: entry.path });
                                setFailure(null);
                              }}
                            >
                              {t("worktrees.existing.move")}
                            </Button>
                            {entry.branch && (
                              <Button
                                size="sm"
                                icon={Icons.GitBranch}
                                onClick={() => {
                                  setAction({ kind: "unlink", path: entry.path });
                                  setFailure(null);
                                }}
                              >
                                {t("worktrees.existing.unlink")}
                              </Button>
                            )}
                            <Button
                              size="sm"
                              icon={Icons.Trash2}
                              onClick={() => {
                                setAction({ kind: "delete", path: entry.path });
                                setFailure(null);
                              }}
                            >
                              {t("worktrees.existing.delete")}
                            </Button>
                          </>
                        )}
                      </>
                    )}
                  </div>
                )}
                {failure?.path === entry.path && (
                  <p role="alert" className="m-0 text-sm text-st-error">
                    {failure.message}
                  </p>
                )}
              </li>
            );
          })}
        </ul>
        <DialogFooter>
          <Button variant="primary" onClick={onClose}>
            {t("worktrees.existing.ok")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
