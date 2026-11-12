// Sidebar chips for a task's pull request and CI state (M7.5, S-09 sidebar row chips).

import { Icons, t } from "@tessera/ui";
import { useAppSelector } from "../store/hooks";

const STATE_TONE: Record<string, string> = {
  open: "text-accent",
  draft: "text-muted",
  merged: "text-st-done",
  closed: "text-st-error",
};
const CI_TONE: Record<string, string> = {
  pending: "text-st-working",
  success: "text-st-done",
  failing: "text-st-error",
};

export function TaskPrChips({ taskId }: { taskId: string }) {
  const task = useAppSelector((state) => state.projects.tasks[taskId]);
  if (!task?.pr_number) return null;
  const state = task.pr_state ?? "open";
  const ci = task.ci_state;
  return (
    <span className="flex shrink-0 items-center gap-1" data-pr-chips>
      <a
        href={task.pr_url ?? "#"}
        target="_blank"
        rel="noreferrer"
        className={`flex items-center gap-0.5 rounded-sm px-1 hover:bg-surface-2 ${STATE_TONE[state] ?? "text-muted"}`}
        title={`#${task.pr_number} · ${t(`pulls.state.${state}` as never)}`}
        onClick={(event) => event.stopPropagation()}
      >
        <Icons.GitPullRequest size={12} aria-hidden />
        <span className="font-mono">#{task.pr_number}</span>
      </a>
      {ci && (
        <span
          className={`flex items-center gap-0.5 ${CI_TONE[ci] ?? "text-muted"}`}
          title={t(`pulls.ci.${ci}` as never)}
          data-ci-chip={ci}
        >
          {ci === "success" ? (
            <Icons.Check size={12} aria-hidden />
          ) : ci === "failing" ? (
            <Icons.X size={12} aria-hidden />
          ) : (
            <Icons.LoaderCircle size={12} aria-hidden />
          )}
        </span>
      )}
    </span>
  );
}
