// Where a task's terminal starts. A pane remembers the folder its shell was last in, but a task belongs to a checkout
// (its worktree, or the project folder): after the project folder moved or the worktree was recreated, the remembered
// folder can be somewhere else that still exists. A task's terminal starts in its checkout unless the remembered folder
// is inside it (a subfolder the user had changed into).
import type { RootState } from "../store";

const clean = (path: string) => path.replace(/[\\/]+$/, "");

export function startFolderFor(state: RootState, taskId: string | undefined, remembered: string): string {
  if (!taskId) return remembered;
  const task = state.projects.tasks[taskId];
  if (!task) return remembered;
  const checkout = task.worktree_path ?? state.projects.projects[task.project_id]?.path;
  if (!checkout) return remembered;
  const root = clean(checkout);
  const here = clean(remembered);
  if (here === root || here.startsWith(`${root}/`) || here.startsWith(`${root}\\`)) return remembered;
  return checkout;
}
