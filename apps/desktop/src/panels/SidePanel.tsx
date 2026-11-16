// The panel docked on the right of the panes: the files the agent changed in the focused folder, or a browser for the
// files in it. Both follow the focused pane's folder, so they show the task's worktree when a task is focused.
import { Button, EmptyState, IconButton, Icons, t } from "@tessera/ui";
import { useCallback, useEffect, useState } from "react";
import { useAppDispatch, useAppSelector } from "../store/hooks";
import { selectFocusedCwd } from "../store/selectors";
import { closeSidePanel } from "../store/uiSlice";
import { openInEditor } from "../terminal/open";
import { toggleReview } from "../review/model";
import { currentTaskId } from "../sidebar/taskTabs";
import { type Changes, type FolderEntry, listFolder, readChanges } from "./client";

export function SidePanel() {
  const panel = useAppSelector((state) => state.ui.sidePanel);
  const dispatch = useAppDispatch();
  const cwd = useAppSelector(selectFocusedCwd);
  if (!panel) return null;
  return (
    <aside
      aria-label={t(panel === "changes" ? "panel.changes" : "panel.files")}
      data-side-panel={panel}
      className="flex w-80 max-w-[45%] shrink-0 flex-col border-s border-border bg-surface"
    >
      <div className="flex items-center gap-2 border-b border-border px-4 py-3">
        <h2 className="m-0 min-w-0 flex-1 truncate text-sm font-semibold">
          {t(panel === "changes" ? "panel.changes" : "panel.files")}
        </h2>
        <IconButton size="sm" icon={Icons.X} label={t("panel.close")} onClick={() => dispatch(closeSidePanel())} />
      </div>
      {cwd ? (
        panel === "changes" ? (
          <ChangesList key={cwd} cwd={cwd} />
        ) : (
          <FilesTree key={cwd} cwd={cwd} />
        )
      ) : (
        <EmptyState className="flex-1" icon={Icons.Folder} message={t("panel.noFolder")} />
      )}
    </aside>
  );
}

const LETTER_TONE: Record<string, string> = {
  M: "text-st-needs",
  A: "text-st-done",
  "?": "text-st-done",
  D: "text-st-error",
  U: "text-st-error",
  R: "text-muted",
};

function ChangesList({ cwd }: { cwd: string }) {
  const [changes, setChanges] = useState<Changes | null>(null);
  const [failed, setFailed] = useState(false);
  const hasTask = useAppSelector((state) => currentTaskId(state) !== null);
  const refresh = useCallback(async () => {
    try {
      setChanges(await readChanges(cwd));
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, [cwd]);
  useEffect(() => {
    void refresh();
    // The agent keeps changing files: look again while the panel is open.
    const timer = setInterval(() => void refresh(), 3000);
    return () => clearInterval(timer);
  }, [refresh]);
  if (failed) return <EmptyState className="flex-1" icon={Icons.GitBranch} message={t("panel.notARepo")} />;
  if (!changes) return <p className="m-0 p-4 text-sm text-muted">{t("panel.loading")}</p>;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <p className="m-0 flex items-center gap-2 border-b border-border px-4 py-2 text-xs text-muted">
        <Icons.GitBranch size={12} aria-hidden />
        <span className="truncate">{changes.branch ?? t("worktrees.existing.detached")}</span>
        <span className="ms-auto tabular-nums">{t("panel.changedCount", { count: changes.files.length })}</span>
      </p>
      {changes.files.length === 0 ? (
        <EmptyState className="flex-1" icon={Icons.Check} message={t("panel.noChanges")} />
      ) : (
        <ul className="m-0 min-h-0 flex-1 list-none overflow-y-auto overscroll-contain p-2">
          {changes.files.map((file) => (
            <li key={file.path}>
              <button
                type="button"
                data-changed-file={file.path}
                title={file.path}
                className="flex w-full cursor-pointer items-center gap-2 rounded-md border-0 bg-transparent px-3 py-2 text-start text-sm text-fg hover:bg-surface-2"
                onClick={() => openInEditor(`${cwd.replace(/[\\/]+$/, "")}/${file.path}`, 1)}
              >
                <span
                  className={`w-4 shrink-0 text-center font-mono text-xs font-semibold ${LETTER_TONE[file.letter] ?? ""}`}
                >
                  {file.letter}
                </span>
                <span className="min-w-0 flex-1 truncate">{file.path}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {hasTask && (
        <div className="border-t border-border p-3">
          <Button size="sm" icon={Icons.GitCompare} className="w-full" onClick={() => toggleReview()}>
            {t("panel.review")}
          </Button>
        </div>
      )}
    </div>
  );
}

function FilesTree({ cwd }: { cwd: string }) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-2" data-files-tree>
      <FolderRows path={cwd} depth={0} />
    </div>
  );
}

function FolderRows({ path, depth }: { path: string; depth: number }) {
  const [entries, setEntries] = useState<FolderEntry[] | null>(null);
  const [error, setError] = useState(false);
  const [open, setOpen] = useState<Set<string>>(new Set());
  useEffect(() => {
    let alive = true;
    listFolder(path)
      .then((list) => alive && setEntries(list))
      .catch(() => alive && setError(true));
    return () => {
      alive = false;
    };
  }, [path]);
  if (error) return <p className="m-0 px-2 py-1 text-xs text-st-error">{t("panel.folderFailed")}</p>;
  if (!entries) return <p className="m-0 px-2 py-1 text-xs text-muted">{t("panel.loading")}</p>;
  if (entries.length === 0 && depth === 0)
    return <p className="m-0 px-2 py-1 text-xs text-muted">{t("panel.emptyFolder")}</p>;
  return (
    <ul className="m-0 list-none p-0">
      {entries.map((entry) => {
        const expanded = open.has(entry.path);
        return (
          <li key={entry.path}>
            <button
              type="button"
              data-file-entry={entry.name}
              aria-expanded={entry.is_dir ? expanded : undefined}
              style={{ paddingInlineStart: `${0.5 + depth * 0.9}rem` }}
              className="flex w-full cursor-pointer items-center gap-1.5 rounded-md border-0 bg-transparent py-1 pe-2 text-start text-sm text-fg hover:bg-surface-2"
              onClick={() =>
                entry.is_dir
                  ? setOpen((current) => {
                      const next = new Set(current);
                      if (!next.delete(entry.path)) next.add(entry.path);
                      return next;
                    })
                  : openInEditor(entry.path, 1)
              }
            >
              {entry.is_dir ? (
                expanded ? (
                  <Icons.FolderOpen size={14} className="shrink-0 text-muted" aria-hidden />
                ) : (
                  <Icons.Folder size={14} className="shrink-0 text-muted" aria-hidden />
                )
              ) : (
                <Icons.FileText size={14} className="shrink-0 text-muted" aria-hidden />
              )}
              <span className="min-w-0 flex-1 truncate">{entry.name}</span>
            </button>
            {entry.is_dir && expanded && <FolderRows path={entry.path} depth={depth + 1} />}
          </li>
        );
      })}
    </ul>
  );
}
