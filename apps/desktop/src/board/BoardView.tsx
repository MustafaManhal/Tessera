// S-06 board view (M7.7, FR-33): every task of the open projects as a card in Backlog, Running, Needs you, Review or
// Done. The column is automatic (see derive.ts) unless the user moved the card by hand. Cards move by dragging or by
// keyboard (Space lifts, Left and Right choose the column, Space drops, Esc cancels). Moving Backlog to Running starts
// the task's agent after a confirmation; moving to Done offers to archive. Opens as an overlay (ui.boardOpen).
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
  IconButton,
  Icons,
  Select,
  StatusPill,
  t,
} from "@tessera/ui";
import type { Status, StringKey } from "@tessera/ui";
import { type DragEvent, type KeyboardEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { launchableLabel, useLaunchable } from "../agents/useLaunchable";
import { agentsErrorMessage } from "../agents/errors";
import { startAgent } from "../agents/launch";
import type { AgentStatus } from "../agents/types";
import type { TaskSummary } from "../projects/types";
import { reviewVisibility, toggleReview } from "../review/model";
import { archiveTaskAction, restoreTaskAction } from "../sidebar/taskActions";
import { openTaskTab } from "../sidebar/taskTabs";
import { useAppDispatch, useAppSelector } from "../store/hooks";
import { announce, setBoardOpen } from "../store/uiSlice";
import { type BoardExtra, COLUMNS, type Column, columnOf, newestSession } from "./derive";
import { boardClient } from "./service";

const POLL_MS = 15_000;
const DONE_LIMIT = 25;
const FILTER_KEY = "tessera.board.filters";

const STATUS: Record<AgentStatus, { pill: Status; label: StringKey }> = {
  starting: { pill: "working", label: "agents.status.starting" },
  working: { pill: "working", label: "agents.status.working" },
  needs_input: { pill: "needs", label: "agents.status.needs" },
  idle: { pill: "off", label: "agents.status.idle" },
  error: { pill: "error", label: "agents.status.error" },
  exited: { pill: "done", label: "agents.status.exited" },
};

const COLUMN_TITLE: Record<Column, StringKey> = {
  backlog: "board.column.backlog",
  running: "board.column.running",
  needs_you: "board.column.needs_you",
  review: "board.column.review",
  done: "board.column.done",
};
const COLUMN_EMPTY: Record<Column, StringKey> = {
  backlog: "board.empty.backlog",
  running: "board.empty.running",
  needs_you: "board.empty.needs_you",
  review: "board.empty.review",
  done: "board.empty.done",
};

function loadFilters(): { project: string; agent: string } {
  try {
    const raw = JSON.parse(window.localStorage.getItem(FILTER_KEY) ?? "{}");
    return {
      project: typeof raw.project === "string" ? raw.project : "all",
      agent: typeof raw.agent === "string" ? raw.agent : "all",
    };
  } catch {
    return { project: "all", agent: "all" };
  }
}

interface Card {
  task: TaskSummary;
  projectName: string;
  agentId: string | null;
  status: AgentStatus | null;
  extra: BoardExtra | undefined;
  auto: Column;
  column: Column;
}

type Pending = { kind: "start"; card: Card } | { kind: "archive"; card: Card } | null;

export function BoardView() {
  const open = useAppSelector((s) => s.ui.boardOpen);
  return open ? <Board /> : null;
}

function Board() {
  const dispatch = useAppDispatch();
  const tasks = useAppSelector((s) => s.projects.tasks);
  const projects = useAppSelector((s) => s.projects.projects);
  const sessions = useAppSelector((s) => s.agentSessions.sessions);
  const [extras, setExtras] = useState<Record<string, BoardExtra>>({});
  const [filters, setFilters] = useState(loadFilters);
  const [lifted, setLifted] = useState<{ taskId: string; target: Column } | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const [over, setOver] = useState<Column | null>(null);
  const [pending, setPending] = useState<Pending>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const rows = await boardClient().boardTasks();
      setExtras(Object.fromEntries(rows.map((row) => [row.task_id, row])));
    } catch {
      // The board still shows the automatic columns.
    }
  }, []);
  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(timer);
  }, [refresh]);
  useEffect(() => {
    try {
      window.localStorage.setItem(FILTER_KEY, JSON.stringify(filters));
    } catch {
      // Filters just are not remembered.
    }
  }, [filters]);

  const sessionList = useMemo(() => Object.values(sessions), [sessions]);
  const allCards = useMemo<Card[]>(
    () =>
      Object.values(tasks)
        .filter((task) => task.state !== "deleted")
        .map((task) => {
          const session = newestSession(sessionList, task.id);
          const extra = extras[task.id];
          const auto = columnOf(task, session, extra ? { ...extra, board_column: null } : undefined);
          return {
            task,
            projectName: projects[task.project_id]?.name ?? "",
            agentId: session?.agent_id ?? null,
            status: session?.status ?? null,
            extra,
            auto,
            column: columnOf(task, session, extra),
          };
        }),
    [tasks, projects, sessionList, extras],
  );
  const agentIds = useMemo(
    () => [...new Set(allCards.map((card) => card.agentId).filter((id): id is string => id !== null))].sort(),
    [allCards],
  );
  const cards = allCards
    .filter((card) => filters.project === "all" || card.task.project_id === filters.project)
    .filter((card) => filters.agent === "all" || card.agentId === filters.agent)
    .sort((a, b) => (b.task.updated_at ?? 0) - (a.task.updated_at ?? 0));
  const byColumn = (column: Column) => cards.filter((card) => card.column === column);

  const close = useCallback(() => dispatch(setBoardOpen(false)), [dispatch]);
  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (document.querySelector('[role="dialog"],[role="alertdialog"]')) return;
      close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [close]);

  const setColumn = useCallback(
    async (card: Card, column: Column | null) => {
      setError(null);
      try {
        await boardClient().taskSetColumn(card.task.id, column);
        await refresh();
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    },
    [refresh],
  );

  const move = useCallback(
    async (card: Card, to: Column) => {
      if (to === card.column) return;
      if (to === "running" && card.column === "backlog") {
        setPending({ kind: "start", card });
        return;
      }
      if (to === "done" && card.task.state !== "archived") {
        setPending({ kind: "archive", card });
        return;
      }
      if (card.task.state === "archived" && to !== "done") await dispatch(restoreTaskAction(card.task.id));
      await setColumn(card, to === card.auto ? null : to);
      dispatch(announce(t("board.moved", { name: card.task.name, column: t(COLUMN_TITLE[to]) })));
    },
    [dispatch, setColumn],
  );

  const onHandleKey = (event: KeyboardEvent<HTMLButtonElement>, card: Card) => {
    const isLifted = lifted?.taskId === card.task.id;
    if (event.key === " ") {
      event.preventDefault();
      event.stopPropagation();
      if (!isLifted) {
        setLifted({ taskId: card.task.id, target: card.column });
        dispatch(announce(t("board.lifted", { name: card.task.name, column: t(COLUMN_TITLE[card.column]) })));
      } else {
        const target = lifted.target;
        setLifted(null);
        void move(card, target);
      }
      return;
    }
    if (!isLifted) return;
    if (event.key === "Escape") {
      event.preventDefault();
      setLifted(null);
      dispatch(announce(t("board.cancelled", { name: card.task.name })));
    } else if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      event.preventDefault();
      const index = COLUMNS.indexOf(lifted.target) + (event.key === "ArrowRight" ? 1 : -1);
      const target = COLUMNS[Math.min(COLUMNS.length - 1, Math.max(0, index))] as Column;
      setLifted({ taskId: card.task.id, target });
      dispatch(
        announce(
          t("board.target", { column: t(COLUMN_TITLE[target]), n: COLUMNS.indexOf(target) + 1, count: COLUMNS.length }),
        ),
      );
    } else if (event.key === "Enter") {
      event.preventDefault();
      const target = lifted.target;
      setLifted(null);
      void move(card, target);
    }
  };
  const onHandleKeyUp = (event: KeyboardEvent<HTMLButtonElement>) => {
    // Space activates a button on key-up; lifting is the only thing Space does here.
    if (event.key === " ") event.preventDefault();
  };

  const onDrop = (event: DragEvent, column: Column) => {
    event.preventDefault();
    const id = event.dataTransfer.getData("text/plain") || dragging;
    setOver(null);
    setDragging(null);
    const card = allCards.find((c) => c.task.id === id);
    if (card) void move(card, column);
  };

  const openTask = (card: Card) => {
    dispatch(openTaskTab(card.task.id));
    close();
  };
  const openReview = (card: Card) => {
    dispatch(openTaskTab(card.task.id));
    if (!reviewVisibility.get()) toggleReview();
    close();
  };

  const projectOptions = [
    { value: "all", label: t("board.allProjects") },
    ...Object.values(projects).map((p) => ({ value: p.id, label: p.name })),
  ];
  const agentOptions = [
    { value: "all", label: t("board.allAgents") },
    ...agentIds.map((id) => ({ value: id, label: id })),
  ];

  return (
    <div className="absolute inset-0 z-30 flex flex-col bg-bg" data-board-view>
      <div className="flex flex-wrap items-center gap-3 border-b border-border px-4 py-3">
        <Icons.Columns3 size={15} aria-hidden />
        <h2 className="m-0 text-sm font-medium">{t("board.title")}</h2>
        <div className="flex-1" />
        <Select
          aria-label={t("board.project")}
          value={filters.project}
          onValueChange={(project) => setFilters((f) => ({ ...f, project }))}
          options={projectOptions}
          className="w-40"
        />
        <Select
          aria-label={t("board.agent")}
          value={filters.agent}
          onValueChange={(agent) => setFilters((f) => ({ ...f, agent }))}
          options={agentOptions}
          className="w-36"
        />
        <IconButton size="sm" icon={Icons.X} label={t("form.close")} onClick={close} />
      </div>
      {error && (
        <p role="alert" data-board-error className="m-0 border-b border-border bg-st-error-tint px-4 py-2 text-sm">
          {error}
        </p>
      )}
      <div className="flex min-h-0 flex-1 gap-4 overflow-x-auto p-4" data-board-columns>
        {COLUMNS.map((column) => {
          const inColumn = byColumn(column);
          const shown = column === "done" ? inColumn.slice(0, DONE_LIMIT) : inColumn;
          const target = over === column || lifted?.target === column;
          return (
            <section
              key={column}
              aria-label={t(COLUMN_TITLE[column])}
              data-board-column={column}
              data-drop-target={target || undefined}
              onDragOver={(event) => {
                if (!dragging) return;
                event.preventDefault();
                setOver(column);
              }}
              onDragLeave={() => setOver((current) => (current === column ? null : current))}
              onDrop={(event) => onDrop(event, column)}
              className={`flex w-64 min-w-56 shrink-0 flex-col rounded-md border bg-surface ${target ? "border-accent-ink" : "border-border"}`}
            >
              <header className="flex items-center gap-2 border-b border-border px-4 py-3">
                <h3 className="m-0 text-sm font-medium">{t(COLUMN_TITLE[column])}</h3>
                <span data-board-count className="rounded-sm bg-surface-3 px-1.5 text-xs text-muted">
                  {inColumn.length}
                </span>
              </header>
              <ul className="m-0 flex min-h-16 flex-1 list-none flex-col gap-3 overflow-y-auto p-3">
                {shown.length === 0 && <li className="p-1 text-sm text-muted">{t(COLUMN_EMPTY[column])}</li>}
                {shown.map((card) => (
                  <li
                    key={card.task.id}
                    data-board-card
                    data-task-id={card.task.id}
                    data-lifted={lifted?.taskId === card.task.id || undefined}
                    className={`rounded-md border bg-surface-2 p-3 shadow-card transition-[transform,box-shadow] motion-safe:hover:-translate-y-px ${lifted?.taskId === card.task.id ? "border-accent-ink" : "border-border"} ${dragging === card.task.id ? "opacity-50" : ""}`}
                  >
                    <button
                      type="button"
                      draggable
                      data-board-handle
                      aria-label={t("board.cardLabel", { name: card.task.name, column: t(COLUMN_TITLE[card.column]) })}
                      aria-pressed={lifted?.taskId === card.task.id}
                      onDragStart={(event) => {
                        event.dataTransfer.setData("text/plain", card.task.id);
                        event.dataTransfer.effectAllowed = "move";
                        setDragging(card.task.id);
                      }}
                      onDragEnd={() => {
                        setDragging(null);
                        setOver(null);
                      }}
                      onClick={() => openTask(card)}
                      onKeyDown={(event) => onHandleKey(event, card)}
                      onKeyUp={onHandleKeyUp}
                      className="flex w-full min-w-0 flex-col items-start gap-1.5 rounded-sm bg-transparent p-0 text-start text-fg"
                    >
                      <span className="w-full truncate text-sm font-medium">{card.task.name}</span>
                      <span className="w-full truncate text-xs text-muted">
                        {card.projectName}
                        {card.task.branch ? ` · ${card.task.branch}` : ""}
                      </span>
                    </button>
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      {card.status && (
                        <StatusPill status={STATUS[card.status].pill} label={t(STATUS[card.status].label)} />
                      )}
                      {card.agentId && <span className="text-xs text-muted">{card.agentId}</span>}
                      {(card.task.changed_files ?? 0) > 0 && (
                        <span data-board-files className="rounded-sm bg-surface-3 px-1 text-xs text-muted">
                          {t("board.files", { count: card.task.changed_files ?? 0 })}
                        </span>
                      )}
                      {card.extra?.pr_number != null && (
                        <span data-board-pr className="rounded-sm bg-surface-3 px-1 text-xs text-muted">
                          {`#${card.extra.pr_number}${card.extra.pr_state ? ` ${card.extra.pr_state}` : ""}`}
                        </span>
                      )}
                      {card.extra?.ci_state && (
                        <span data-board-ci className="rounded-sm bg-surface-3 px-1 text-xs text-muted">
                          {t("board.ci", { state: card.extra.ci_state })}
                        </span>
                      )}
                    </div>
                    <div className="mt-2 flex flex-wrap gap-2">
                      <Button size="sm" variant="ghost" data-board-review onClick={() => openReview(card)}>
                        {t("board.review")}
                      </Button>
                      {card.extra?.board_column && (
                        <Button size="sm" variant="ghost" data-board-reset onClick={() => void setColumn(card, null)}>
                          {t("board.reset")}
                        </Button>
                      )}
                    </div>
                  </li>
                ))}
                {column === "done" && inColumn.length > DONE_LIMIT && (
                  <li className="p-2 text-xs text-muted">
                    {t("board.moreDone", { count: inColumn.length - DONE_LIMIT })}
                  </li>
                )}
              </ul>
            </section>
          );
        })}
      </div>
      <p className="m-0 border-t border-border px-4 py-2 text-xs text-muted">{t("board.keyboardHint")}</p>
      {pending?.kind === "start" && (
        <StartDialog
          card={pending.card}
          onClose={() => setPending(null)}
          onStarted={async () => {
            setPending(null);
            // Hand the card back to the automatic columns: the running agent puts it in Running.
            await setColumn(pending.card, null);
          }}
        />
      )}
      {pending?.kind === "archive" && (
        <ArchiveDialog
          card={pending.card}
          onClose={() => setPending(null)}
          onArchive={async () => {
            const card = pending.card;
            setPending(null);
            await dispatch(archiveTaskAction(card.task.id));
            await setColumn(card, null);
          }}
          onOnlyMove={async () => {
            const card = pending.card;
            setPending(null);
            await setColumn(card, "done");
          }}
        />
      )}
    </div>
  );
}

function StartDialog({
  card,
  onClose,
  onStarted,
}: {
  card: Card;
  onClose: () => void;
  onStarted: () => Promise<void>;
}) {
  const dispatch = useAppDispatch();
  const { items, loading } = useLaunchable();
  const [choice, setChoice] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const options = items.map((item) => ({ value: item.profile.id, label: launchableLabel(item) }));
  const first = useRef(false);
  useEffect(() => {
    if (!first.current && options[0]) {
      first.current = true;
      setChoice(options[0].value);
    }
  }, [options]);
  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      await dispatch(startAgent({ profileId: choice, prompt: card.task.prompt, taskId: card.task.id, cwd: null }));
      await onStarted();
    } catch (cause) {
      setError(agentsErrorMessage(cause));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent data-board-start-dialog>
        <DialogTitle>{t("board.start.title", { name: card.task.name })}</DialogTitle>
        <DialogDescription>{t("board.start.body")}</DialogDescription>
        {!loading && options.length === 0 ? (
          <p role="alert" className="m-0 text-sm text-danger">
            {t("handoff.noAgent")}
          </p>
        ) : (
          <Select aria-label={t("handoff.agent")} value={choice} onValueChange={setChoice} options={options} />
        )}
        {error && (
          <p
            role="alert"
            data-form-error
            className="m-0 rounded-md border border-border bg-st-error-tint px-3 py-2 text-sm"
          >
            {error}
          </p>
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            {t("button.cancel")}
          </Button>
          <Button variant="primary" disabled={busy || !choice} onClick={() => void start()}>
            {t("board.start.confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ArchiveDialog({
  card,
  onClose,
  onArchive,
  onOnlyMove,
}: {
  card: Card;
  onClose: () => void;
  onArchive: () => Promise<void>;
  onOnlyMove: () => Promise<void>;
}) {
  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent data-board-archive-dialog>
        <DialogTitle>{t("board.archive.title", { name: card.task.name })}</DialogTitle>
        <DialogDescription>{t("board.archive.body")}</DialogDescription>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            {t("button.cancel")}
          </Button>
          <Button variant="ghost" data-board-only-move onClick={() => void onOnlyMove()}>
            {t("board.archive.onlyMove")}
          </Button>
          <Button variant="primary" data-board-archive onClick={() => void onArchive()}>
            {t("board.archive.confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
