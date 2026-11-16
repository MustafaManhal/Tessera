// biome-ignore-all lint/suspicious/noArrayIndexKey: diff rows are positional text; the index is their identity.
// S-08 compare view for a best-of-N group: one column per sibling task, a shared file selector, per-column
// scrollable unified diffs, and "Pick this one" → taskGroupPick → archive-the-others dialog. Opens as an overlay
// over the shell content (ui.compareGroup), Esc closes.
import { Button, IconButton, Icons, t } from "@tessera/ui";
import { useEffect, useMemo, useRef, useState } from "react";
import { useAppDispatch, useAppSelector } from "../store/hooks";
import { setCompareGroup, setProjectDialog } from "../store/uiSlice";
import { projectsClient } from "../projects/service";
import type { TaskSummary } from "../projects/types";
import { compareDiffSource } from "./source";
import { diffStats, unionFiles, type UnionFile } from "./files";

interface Column {
  task: TaskSummary;
  agent: string | null;
  status: string | null;
  files: string[];
  diffs: Map<string, string | null>;
  additions: number;
  deletions: number;
}

export function CompareView() {
  const groupId = useAppSelector((s) => s.ui.compareGroup);
  const group = useAppSelector((s) => (groupId ? s.projects.groups[groupId] : undefined));
  const tasks = useAppSelector((s) => s.projects.tasks);
  const sessions = useAppSelector((s) => s.agentSessions.sessions);
  const dispatch = useAppDispatch();
  const [selected, setSelected] = useState<string | null>(null);
  const [columns, setColumns] = useState<Column[]>([]);
  const [union, setUnion] = useState<UnionFile[]>([]);
  // Sessions churn on every status tick; the file lists only need the latest snapshot, not a refetch.
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;
  const members = useMemo(
    () =>
      group
        ? Object.values(tasks)
            .filter((task) => task.group_id === group.id && task.state !== "archived")
            .sort((a, b) => (a.created_at ?? 0) - (b.created_at ?? 0))
        : [],
    [group, tasks],
  );

  // Load every sibling's file list once per group; diffs load lazily per selected file.
  useEffect(() => {
    if (!group) return;
    let cancelled = false;
    const source = compareDiffSource();
    void Promise.all(
      members.map(async (task) => {
        const files = await source.files(task.id).catch(() => [] as string[]);
        const mine = Object.values(sessionsRef.current).filter((s) => s.task_id === task.id);
        const session = mine.sort((a, b) => b.started_at - a.started_at)[0];
        return { task, files, agent: session?.agent_id ?? null, status: session?.status ?? null };
      }),
    ).then(async (cols) => {
      if (cancelled) return;
      const withDiffs = await Promise.all(
        cols.map(async (col) => {
          const diffs = new Map<string, string | null>();
          // Stats need every file's diff; load them all (fake is instant; real adapter is per-file anyway).
          for (const path of col.files) diffs.set(path, await source.diff(col.task.id, path).catch(() => null));
          let additions = 0;
          let deletions = 0;
          for (const diff of diffs.values()) {
            if (!diff) continue;
            const stats = diffStats(diff);
            additions += stats.additions;
            deletions += stats.deletions;
          }
          return { ...col, diffs, additions, deletions };
        }),
      );
      if (cancelled) return;
      setColumns(withDiffs);
      setUnion(unionFiles(new Map(withDiffs.map((c) => [c.task.id, c.files]))));
      setSelected(
        (current) => current ?? unionFiles(new Map(withDiffs.map((c) => [c.task.id, c.files])))[0]?.path ?? null,
      );
    });
    return () => {
      cancelled = true;
    };
  }, [group, members]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") dispatch(setCompareGroup(null));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [dispatch]);

  if (!group) return null;
  const close = () => dispatch(setCompareGroup(null));
  const pick = async (column: Column) => {
    await projectsClient()
      .taskGroupPick(group.id, column.task.id)
      .catch(() => {});
    close();
    dispatch(setProjectDialog({ kind: "archiveGroupOthers", groupId: group.id }));
  };

  return (
    <div className="absolute inset-0 z-30 flex flex-col bg-bg" data-compare-view>
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <Icons.Layers size={15} aria-hidden />
        <span className="text-sm font-medium">{group.name}</span>
        <span className="text-xs text-muted">{t("compare.subtitle", { count: members.length })}</span>
        <div className="flex-1" />
        <IconButton size="sm" icon={Icons.X} label={t("form.close")} onClick={close} />
      </div>
      <div className="flex min-h-0 flex-1">
        <div
          className="w-56 shrink-0 overflow-y-auto border-r border-border"
          role="listbox"
          aria-label={t("compare.files")}
        >
          {union.map((file) => (
            <button
              key={file.path}
              type="button"
              role="option"
              aria-selected={selected === file.path}
              data-compare-file={file.path}
              onClick={() => setSelected(file.path)}
              className={`block w-full truncate px-3 py-1.5 text-left text-xs ${
                selected === file.path ? "bg-surface-2 text-fg" : "text-muted hover:bg-surface-2"
              }`}
            >
              {file.path}
              <span className="ml-1 text-muted">
                {t("compare.changedIn", { changed: file.changedIn, total: file.total })}
              </span>
            </button>
          ))}
          {union.length === 0 && <p className="px-3 py-2 text-xs text-muted">{t("compare.noFiles")}</p>}
        </div>
        <div className="flex min-w-0 flex-1 gap-2 overflow-x-auto p-2">
          {columns.map((column) => {
            const diff = selected ? (column.diffs.get(selected) ?? null) : null;
            const changed = selected ? column.files.includes(selected) : false;
            return (
              <section
                key={column.task.id}
                data-compare-column={column.task.id}
                className="flex min-w-64 flex-1 flex-col rounded-md border border-border"
              >
                <header className="flex items-center gap-2 border-b border-border px-2 py-1.5">
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-xs font-medium">{column.task.name}</div>
                    <div className="truncate text-[11px] text-muted">
                      {column.agent ?? "—"}
                      {column.status ? ` · ${column.status}` : ""}
                    </div>
                  </div>
                  <span className="text-[11px] tabular-nums text-success">+{column.additions}</span>
                  <span className="text-[11px] tabular-nums text-danger">−{column.deletions}</span>
                  <span className="text-[11px] text-muted">
                    {t("compare.filesCount", { count: column.files.length })}
                  </span>
                </header>
                <div className="min-h-0 flex-1 overflow-auto p-1 font-mono text-[11px] leading-4">
                  {!changed ? (
                    <p className="p-2 text-muted">{t("compare.notChanged")}</p>
                  ) : diff ? (
                    <DiffLines text={diff} columnKey={`${column.task.id}:${selected ?? ""}`} />
                  ) : (
                    <p className="p-2 text-muted">{t("compare.noDiff")}</p>
                  )}
                </div>
                <footer className="border-t border-border p-1.5">
                  <Button
                    size="sm"
                    variant={group.picked_task_id === column.task.id ? "ghost" : "primary"}
                    onClick={() => void pick(column)}
                  >
                    {group.picked_task_id === column.task.id ? t("taskGroup.picked") : t("compare.pick")}
                  </Button>
                </footer>
              </section>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function DiffLines({ text, columnKey }: { text: string; columnKey: string }) {
  return (
    <>
      {text.split("\n").map((line, index) => (
        <div
          key={`${columnKey}:${index}`}
          className={
            line.startsWith("+") && !line.startsWith("+++")
              ? "bg-success/10 text-success"
              : line.startsWith("-") && !line.startsWith("---")
                ? "bg-danger/10 text-danger"
                : "text-muted"
          }
        >
          {line || " "}
        </div>
      ))}
    </>
  );
}
