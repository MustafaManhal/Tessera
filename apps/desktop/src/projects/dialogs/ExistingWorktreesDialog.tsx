// The worktrees git already had in a project's repository. They are not Tessera's: it lists them, never opens or
// changes them by itself, and offers a terminal in one only when the user asks for it.
import { Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle, Icons, t } from "@tessera/ui";
import { useAppDispatch } from "../../store/hooks";
import { layout } from "../../store/layoutSlice";
import type { Project, WorktreeFacts } from "../types";

export function ExistingWorktreesDialog({
  project,
  worktrees,
  onClose,
}: {
  project: Project;
  worktrees: WorktreeFacts[];
  onClose: () => void;
}) {
  const dispatch = useAppDispatch();
  const open = (entry: WorktreeFacts) => {
    const name = entry.path.split(/[\\/]/).filter(Boolean).pop() ?? entry.path;
    dispatch(layout({ type: "tab/new", cwd: entry.path, title: name }));
    onClose();
  };
  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent data-existing-worktrees>
        <DialogTitle>{t("worktrees.existing.title", { name: project.name })}</DialogTitle>
        <DialogDescription>{t("worktrees.existing.body")}</DialogDescription>
        <ul className="m-0 flex max-h-64 list-none flex-col gap-2 overflow-auto p-0">
          {worktrees.map((entry) => (
            <li
              key={entry.path}
              data-existing-worktree
              className="flex items-center gap-2 rounded-lg border border-border bg-surface-2 p-2"
            >
              <Icons.GitBranch size={14} className="shrink-0 text-muted" aria-hidden />
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium">
                  {entry.branch ?? (entry.detached ? t("worktrees.existing.detached") : "—")}
                </span>
                <span className="block truncate font-mono text-xs text-muted" title={entry.path}>
                  {entry.path}
                </span>
              </span>
              <Button size="sm" icon={Icons.SquareTerminal} onClick={() => open(entry)}>
                {t("worktrees.existing.open")}
              </Button>
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
