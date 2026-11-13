// The worktrees git already had in a project's repository. They are not Tessera's: it never opens, changes or deletes
// one by itself. This dialog lists them, and each row offers a terminal, "add as task" (the task works in that
// folder) and delete, only when the user asks.
import { Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle, Icons, t } from "@tessera/ui";
import { useState } from "react";
import { notifications } from "../../notify";
import { useAppDispatch, useAppSelector } from "../../store/hooks";
import { layout } from "../../store/layoutSlice";
import { mapProjectsError } from "../errors";
import { projectsClient } from "../service";
import { createTask } from "../thunks";
import type { WorktreeFacts } from "../types";
import { useForeignWorktrees } from "../useCheckouts";

const folderName = (path: string) => path.split(/[\\/]/).filter(Boolean).pop() ?? path;

export function ExistingWorktreesDialog({ projectId, onClose }: { projectId: string; onClose: () => void }) {
  const dispatch = useAppDispatch();
  const project = useAppSelector((state) => state.projects.projects[projectId]);
  const [refresh, setRefresh] = useState(0);
  const worktrees = useForeignWorktrees(project, refresh);
  // The row asking "delete this?", and the failure to show for a row.
  const [asking, setAsking] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [failure, setFailure] = useState<{ path: string; message: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  if (!project) return null;

  const open = (entry: WorktreeFacts) => {
    dispatch(layout({ type: "tab/new", cwd: entry.path, title: folderName(entry.path) }));
    onClose();
  };
  const restore = async (entry: WorktreeFacts) => {
    if (!entry.branch) return;
    setBusy(entry.path);
    setFailure(null);
    try {
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
      if (created) notifications().toastNow({ title: t("worktrees.existing.restored", { name: created.name }) });
      setRefresh((n) => n + 1);
    } catch (cause) {
      setFailure({ path: entry.path, message: mapProjectsError(cause).message });
    } finally {
      setBusy(null);
    }
  };
  const remove = async (entry: WorktreeFacts, force: boolean) => {
    setBusy(entry.path);
    setFailure(null);
    try {
      await projectsClient().worktreeRemove(project.path, entry.path, force);
      setAsking(null);
      setDirty(false);
      setRefresh((n) => n + 1);
    } catch (cause) {
      const message = mapProjectsError(cause).message;
      // Git refuses a worktree with changes unless forced: say so and offer the forced delete.
      if (!force && /modified|untracked|changes|dirty|contains/i.test(message)) setDirty(true);
      else setFailure({ path: entry.path, message });
    } finally {
      setBusy(null);
    }
  };

  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent data-existing-worktrees>
        <DialogTitle>{t("worktrees.existing.title", { name: project.name })}</DialogTitle>
        <DialogDescription>{t("worktrees.existing.body")}</DialogDescription>
        {worktrees.length === 0 && <p className="m-0 text-sm text-muted">{t("worktrees.existing.empty")}</p>}
        <ul className="m-0 flex max-h-72 list-none flex-col gap-2 overflow-auto p-0">
          {worktrees.map((entry) => (
            <li
              key={entry.path}
              data-existing-worktree
              className="flex flex-col gap-2 rounded-lg border border-border bg-surface-2 p-2"
            >
              <div className="flex items-center gap-2">
                <Icons.GitBranch size={14} className="shrink-0 text-muted" aria-hidden />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">
                    {entry.branch ?? (entry.detached ? t("worktrees.existing.detached") : "—")}
                  </span>
                  <span className="block truncate font-mono text-xs text-muted" title={entry.path}>
                    {entry.path}
                  </span>
                </span>
              </div>
              {asking === entry.path ? (
                <div className="flex flex-col gap-2" data-delete-ask>
                  <p className="m-0 text-sm">
                    {dirty ? t("worktrees.existing.deleteDirty") : t("worktrees.existing.deleteAsk")}
                  </p>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      size="sm"
                      variant="danger"
                      disabled={busy === entry.path}
                      onClick={() => void remove(entry, dirty)}
                    >
                      {dirty ? t("worktrees.existing.deleteForce") : t("worktrees.existing.deleteConfirm")}
                    </Button>
                    <Button
                      size="sm"
                      onClick={() => {
                        setAsking(null);
                        setDirty(false);
                      }}
                    >
                      {t("worktrees.existing.cancel")}
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" icon={Icons.SquareTerminal} onClick={() => open(entry)}>
                    {t("worktrees.existing.open")}
                  </Button>
                  {entry.branch && (
                    <Button
                      size="sm"
                      icon={Icons.Plus}
                      disabled={busy === entry.path}
                      onClick={() => void restore(entry)}
                    >
                      {t("worktrees.existing.restore")}
                    </Button>
                  )}
                  <Button
                    size="sm"
                    icon={Icons.Trash2}
                    onClick={() => {
                      setAsking(entry.path);
                      setDirty(false);
                      setFailure(null);
                    }}
                  >
                    {t("worktrees.existing.delete")}
                  </Button>
                </div>
              )}
              {failure?.path === entry.path && (
                <p role="alert" className="m-0 text-sm text-st-error">
                  {failure.message}
                </p>
              )}
            </li>
          ))}
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
