import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Button, Icons, t } from "@tessera/ui";
import { useAppDispatch, useAppSelector } from "../store/hooks";
import { currentTaskId } from "../sidebar/taskTabs";
import { openTaskInEditorAction } from "../sidebar/taskActions";
import type { Task } from "../projects/types";
import { reviewClient, type ChangedFile, type FileDiff } from "./client";
import { fileTree, reviewVisibility, shouldAutoRefresh, toggleReview } from "./model";
import { StagingControls } from "./StagingControls";
import { Comments } from "./Comments";
import { useComments } from "./useComments";
import { PrPanel } from "../pulls/PrPanel";

// CodeMirror is large and only needed once a file is open: load it then, not at start (cold start, NFR-03).
const DiffView = lazy(() => import("./DiffView").then((module) => ({ default: module.DiffView })));
function errorMessage(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  if (typeof cause === "object" && cause && "message" in cause) return String(cause.message);
  return String(cause);
}
export function ReviewPanel() {
  const open = useSyncExternalStore(reviewVisibility.subscribe, reviewVisibility.get);
  const id = useAppSelector(currentTaskId);
  const task = useAppSelector((state) => (id ? state.projects.tasks[id] : undefined));
  const project = useAppSelector((state) => (task ? state.projects.projects[task.project_id] : undefined));
  const remote = (task?.worktree_path ?? project?.path)?.startsWith("ssh://") ?? false;
  return open && task ? <TaskReview key={task.id} task={task} remote={remote} /> : null;
}
function TaskReview({ task, remote }: { task: Task; remote: boolean }) {
  const [prOpen, setPrOpen] = useState(false);
  const dispatch = useAppDispatch();
  const client = reviewClient();
  const comments = useComments(task.id);
  const [files, setFiles] = useState<ChangedFile[]>([]),
    [selected, setSelected] = useState<string | null>(null),
    [content, setContent] = useState<FileDiff | null>(null);
  const commentActions = useMemo(
    () => ({
      edit: comments.edit,
      remove: (row: Parameters<typeof comments.remove>[0]) => void comments.remove(row),
      resolve: (row: Parameters<typeof comments.resolve>[0]) => void comments.resolve(row),
    }),
    [comments.edit, comments.remove, comments.resolve],
  );
  const fileComments = useMemo(() => comments.rows.filter((c) => c.file_path === selected), [comments.rows, selected]);
  const [tree, setTree] = useState(true),
    [unified, setUnified] = useState(false),
    [ignoreWhitespace, setIgnoreWhitespace] = useState(false),
    [dirty, setDirty] = useState(false),
    [hover, setHover] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [version, setVersion] = useState(0);
  const snapshot = useRef({ files, content, selected, dirty, busy });
  snapshot.current = { files, content, selected, dirty, busy };
  const request = useRef(0);
  const mounted = useRef(true);
  const list = useRef<HTMLDivElement>(null);
  const refresh = useCallback(async () => {
    const generation = ++request.current;
    setBusy(true);
    setError("");
    setDirty(false);
    try {
      const next = await client.files(task.id);
      if (!mounted.current || generation !== request.current) return;
      setFiles(next);
      setSelected((old) => (next.some((f) => f.path === old) ? old : (next[0]?.path ?? null)));
      setVersion((v) => v + 1);
    } catch (cause) {
      if (mounted.current && generation === request.current) setError(errorMessage(cause));
    } finally {
      if (mounted.current && generation === request.current) setBusy(false);
    }
  }, [client, task.id]);
  useEffect(() => {
    mounted.current = true;
    void refresh();
    return () => {
      mounted.current = false;
      request.current++;
    };
  }, [refresh]);
  useEffect(() => {
    let stopped = false;
    let off: (() => void) | undefined;
    let polling = false;
    const poll = async () => {
      const view = snapshot.current;
      if (polling || view.dirty || view.busy) return;
      polling = true;
      const generation = request.current;
      try {
        const next = await client.files(task.id);
        let changed = JSON.stringify(next) !== JSON.stringify(view.files);
        if (!changed && view.selected && view.content) {
          changed = JSON.stringify(await client.diff(task.id, view.selected)) !== JSON.stringify(view.content);
        }
        if (!stopped && request.current === generation && snapshot.current.selected === view.selected) {
          if (changed) setDirty(true);
          setError("");
        }
      } catch (cause) {
        if (!stopped) setError(errorMessage(cause));
      } finally {
        polling = false;
      }
    };
    const timer = remote ? setInterval(() => void poll(), 10_000) : undefined;
    if (!remote)
      void client
        .onChanged((id) => {
          if (!stopped && id === task.id) setDirty(true);
        })
        .then((fn) => {
          if (stopped) fn();
          else off = fn;
        })
        .catch(() => {});
    return () => {
      stopped = true;
      off?.();
      if (timer) clearInterval(timer);
    };
  }, [client, task.id, remote]);
  useEffect(() => {
    if (shouldAutoRefresh(dirty, hover, busy)) void refresh();
  }, [dirty, hover, busy, refresh]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: version reloads an unchanged selection after a refresh.
  useEffect(() => {
    let active = true;
    setContent(null);
    if (selected)
      void client
        .diff(task.id, selected)
        .then((value) => {
          if (active) setContent(value);
        })
        .catch((cause) => {
          if (active)
            setError(typeof cause === "object" && cause && "message" in cause ? String(cause.message) : String(cause));
        });
    return () => {
      active = false;
    };
  }, [client, task.id, selected, version]);
  const entries = tree ? fileTree(files) : files.map((file) => ({ path: file.path, name: file.path, depth: 0, file }));
  const total = files.reduce((sum, f) => ({ added: sum.added + f.added, removed: sum.removed + f.removed }), {
    added: 0,
    removed: 0,
  });
  return (
    <aside
      aria-label={t("review.title")}
      data-review-panel
      className="absolute inset-y-0 right-0 z-20 flex w-3/5 min-w-80 max-w-full flex-col border-l border-border bg-surface text-fg shadow-lg"
    >
      <header className="flex flex-wrap items-center gap-2 border-b border-border p-2">
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-sm font-medium">{task.name}</h2>
          <p className="truncate text-xs text-muted" title={`${task.branch} → ${task.base_branch}`}>
            {task.branch} → {task.base_branch}
          </p>
        </div>
        <span className="text-xs text-st-done">+{total.added}</span>
        <span className="text-xs text-st-error">−{total.removed}</span>
        <span className="text-xs">
          {files.length} {t("review.files")}
        </span>
        <Button
          size="sm"
          variant={prOpen ? "secondary" : "ghost"}
          icon={Icons.GitPullRequest}
          onClick={() => setPrOpen((v) => !v)}
          aria-expanded={prOpen}
        >
          {t("pulls.create")}
        </Button>
        <Button size="sm" variant="ghost" onClick={toggleReview}>
          {t("review.close")}
        </Button>
      </header>
      {prOpen && <PrPanel taskId={task.id} />}
      <div className="flex flex-wrap items-center gap-1 border-b border-border p-2">
        <Button size="sm" variant="ghost" aria-pressed={tree} onClick={() => setTree((v) => !v)}>
          {tree ? t("review.tree") : t("review.flat")}
        </Button>
        <Button size="sm" variant="ghost" aria-pressed={unified} onClick={() => setUnified((v) => !v)}>
          {unified ? t("review.unified") : t("review.split")}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          aria-pressed={ignoreWhitespace}
          onClick={() => setIgnoreWhitespace((v) => !v)}
        >
          {t("review.whitespace")}
        </Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => void refresh()}>
          {dirty ? t("review.updated") : t("review.refresh")}
        </Button>
      </div>
      {error && (
        <p role="alert" className="p-2 text-sm text-st-error">
          {error}
        </p>
      )}
      {!busy && files.length === 0 ? (
        <p className="p-4 text-sm text-muted">{t("review.empty")}</p>
      ) : (
        <div className="flex min-h-0 flex-1">
          <div
            ref={list}
            role="listbox"
            aria-label={t("review.files")}
            className="w-1/3 min-w-28 overflow-auto border-r border-border p-1"
            onKeyDown={(event) => {
              const options = Array.from(list.current?.querySelectorAll<HTMLButtonElement>('[role="option"]') ?? []);
              const current = options.indexOf(document.activeElement as HTMLButtonElement);
              if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                event.preventDefault();
                options[(current + (event.key === "ArrowDown" ? 1 : -1) + options.length) % options.length]?.focus();
              }
            }}
          >
            {entries.map((entry) =>
              entry.file ? (
                <button
                  key={entry.path}
                  type="button"
                  role="option"
                  aria-selected={selected === entry.path}
                  title={entry.file.old_path ? `${entry.file.old_path} → ${entry.path}` : entry.path}
                  onClick={() => setSelected(entry.path)}
                  className={`flex w-full items-center gap-1 rounded-sm px-1 py-1 text-left text-xs ${selected === entry.path ? "bg-surface-2" : ""}`}
                  style={{ paddingInlineStart: `${entry.depth + 0.5}em` }}
                >
                  <span aria-hidden className={entry.file.status === "U" ? "text-st-error" : "text-muted"}>
                    {entry.file.status === "U" ? <Icons.FileWarning size={12} aria-hidden /> : entry.file.status}
                  </span>
                  <span className="min-w-0 flex-1 truncate">{entry.name}</span>
                </button>
              ) : (
                <div
                  key={`dir:${entry.path}`}
                  className="truncate py-1 text-xs text-muted"
                  style={{ paddingInlineStart: `${entry.depth + 0.5}em` }}
                >
                  {entry.name}/
                </div>
              ),
            )}
          </div>
          <div
            className="flex min-h-0 min-w-0 flex-1 flex-col"
            onPointerEnter={() => setHover(true)}
            onPointerLeave={() => setHover(false)}
          >
            {selected && (
              <div className="truncate border-b border-border px-2 py-1 text-xs text-muted" title={selected}>
                {selected}
              </div>
            )}
            {content?.conflict && (
              <div className="border-b border-border p-2 text-sm text-st-error">
                <span>{t("review.conflict")}</span>{" "}
                <Button size="sm" variant="ghost" onClick={() => void dispatch(openTaskInEditorAction(task.id))}>
                  {t("review.resolve")}
                </Button>
              </div>
            )}
            {content?.binary ? (
              <p className="p-4 text-sm text-muted">{t("review.binary")}</p>
            ) : content?.too_large ? (
              <div className="p-4 text-sm text-muted">
                {t("review.large")}{" "}
                <Button size="sm" variant="ghost" onClick={() => void dispatch(openTaskInEditorAction(task.id))}>
                  {t("review.editor")}
                </Button>
              </div>
            ) : content && selected ? (
              <Suspense fallback={<p className="p-4 text-sm text-muted">{t("button.loading")}</p>}>
                <DiffView
                  path={selected}
                  base={content.base_text ?? ""}
                  head={content.head_text ?? ""}
                  unified={unified}
                  ignoreWhitespace={ignoreWhitespace}
                  comments={fileComments}
                  onComment={comments.select}
                  commentActions={commentActions}
                />
              </Suspense>
            ) : (
              <p className="p-4 text-sm text-muted">{t("button.loading")}</p>
            )}
          </div>
        </div>
      )}
      <StagingControls taskId={task.id} path={selected} version={version} onRefresh={refresh} />
      <Comments
        model={comments}
        selection={
          selected && content && !content.binary && !content.too_large
            ? {
                file_path: selected,
                side: "head",
                line_start: 1,
                line_end: 1,
                code_excerpt: (content.head_text ?? "").split("\n")[0] ?? "",
              }
            : null
        }
      />
    </aside>
  );
}
