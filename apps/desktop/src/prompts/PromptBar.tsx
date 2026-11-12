// The prompt bar (FR-40, S-23): Cmd/Ctrl+L opens it over the panes — target chips for running agent sessions
// (focused agent preselected, "All in this task", multi-select), a multi-line input (Enter sends, Shift+Enter is a
// newline, ↑/↓ walks prompt history at the caret edges, Esc closes), and a "/" picker for library prompts.
// Sending expands {{variables}}, writes bracketed paste + Enter to each target's PTY, records history and a
// `prompt_sent` agent event.
import { Button, cn, t } from "@tessera/ui";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { sendPromptToAgents } from "./send";
import { useAppDispatch, useAppSelector } from "../store/hooks";
import type { RootState } from "../store";
import { closePromptBar } from "../store/uiSlice";
import { prompts, type PromptEntry } from "./client";
import { openPromptBar } from "../store/uiSlice";
import { expandVariables, type VariableValues } from "./variables";

const HISTORY_LIMIT = 100;

interface Target {
  sessionId: string;
  paneId: string;
  label: string;
  taskId: string | null;
}

/** All sendable agent sessions (exited cannot be targeted), grouped per task for "All in this task". */
function targetsOf(sessions: RootState["agentSessions"]["sessions"], panes: RootState["layout"]["panes"]): Target[] {
  const out: Target[] = [];
  for (const session of Object.values(sessions)) {
    if (!session.pane_id || session.status === "exited" || !panes[session.pane_id]) continue;
    out.push({
      sessionId: session.id,
      paneId: session.pane_id,
      label: `${session.agent_id} · ${session.pane_id.slice(0, 8)}`,
      taskId: session.task_id,
    });
  }
  return out;
}

export function PromptBar() {
  const dispatch = useAppDispatch();
  const bar = useAppSelector((state) => state.ui.promptBar);
  const sessions = useAppSelector((state) => state.agentSessions.sessions);
  const panes = useAppSelector((state) => state.layout.panes);
  const tabs = useAppSelector((state) => state.layout.tabs);
  const activeTab = useAppSelector((state) => state.layout.activeTab);
  const tasks = useAppSelector((state) => state.projects.tasks);
  const [text, setText] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [allInTask, setAllInTask] = useState(false);
  const [history, setHistory] = useState<string[]>([]);
  const [, setHistoryIndex] = useState<number | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerQuery, setPickerQuery] = useState("");
  const [library, setLibrary] = useState<PromptEntry[]>([]);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const barRef = useRef<HTMLDivElement>(null);

  const targets = useMemo(() => targetsOf(sessions, panes), [sessions, panes]);
  const focusedPane = useMemo(() => {
    const tab = tabs.find((tb) => tb.id === activeTab);
    return tab?.focusedPane ?? null;
  }, [tabs, activeTab]);

  // DEV/test hook: ?prompt=1 opens the bar on load (audit-ui, screenshots).
  useEffect(() => {
    if (import.meta.env.DEV && new URLSearchParams(window.location.search).has("prompt")) {
      dispatch(openPromptBar());
    }
  }, [dispatch]);

  // Initialise once per open; late session/layout updates must not wipe what the user typed.
  const initializedFor = useRef(false);
  useEffect(() => {
    if (!bar?.open) {
      initializedFor.current = false;
      return;
    }
    if (initializedFor.current) return;
    initializedFor.current = true;
    setText(bar.text);
    setHistoryIndex(null);
    setPickerOpen(false);
    const preset = bar.agentSessionIds;
    const initial = preset.length > 0 ? new Set(preset) : new Set<string>();
    // Focused agent pane's session preselected.
    const focusedSession = targets.find((target) => target.paneId === focusedPane);
    if (preset.length === 0 && focusedSession) initial.add(focusedSession.sessionId);
    setSelected(initial);
    setAllInTask(false);
    void prompts()
      .history(HISTORY_LIMIT)
      .then((rows) => setHistory(rows.map((row) => row.text).reverse()))
      .catch(() => {});
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [bar?.open, bar?.text, bar?.agentSessionIds, focusedPane, targets]);

  // Escape closes; clicks outside close.
  useEffect(() => {
    if (!bar?.open) return;
    const onDown = (event: MouseEvent) => {
      if (barRef.current && !barRef.current.contains(event.target as Node)) dispatch(closePromptBar());
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [bar?.open, dispatch]);

  // Library search for the "/" picker.
  useEffect(() => {
    if (!pickerOpen) return;
    const timer = setTimeout(() => {
      void prompts()
        .list(pickerQuery || undefined)
        .then(setLibrary)
        .catch(() => {});
    }, 120);
    return () => clearTimeout(timer);
  }, [pickerOpen, pickerQuery]);

  const taskNameOf = useCallback((taskId: string | null) => (taskId ? (tasks[taskId]?.name ?? null) : null), [tasks]);

  const branchOf = useCallback((taskId: string | null) => (taskId ? (tasks[taskId]?.branch ?? null) : null), [tasks]);

  const effectiveTargets = useMemo(() => {
    if (allInTask) {
      const taskIds = new Set(targets.map((target) => target.taskId).filter(Boolean));
      return targets.filter((target) => taskIds.has(target.taskId));
    }
    return targets.filter((target) => selected.has(target.sessionId));
  }, [allInTask, selected, targets]);

  const send = async () => {
    const trimmed = text.trim();
    if (!trimmed || effectiveTargets.length === 0) return;
    // Variable context from the first target's task (they usually share one task).
    const taskId = effectiveTargets[0]?.taskId ?? null;
    const values: VariableValues = {
      task: taskNameOf(taskId),
      branch: branchOf(taskId),
      issue: null,
    };
    const expanded = expandVariables(trimmed, values);
    sendPromptToAgents(expanded, effectiveTargets);
    dispatch(closePromptBar());
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void send();
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      dispatch(closePromptBar());
      return;
    }
    if ((event.key === "ArrowUp" || event.key === "ArrowDown") && history.length > 0) {
      const el = event.currentTarget;
      const atStart = el.selectionStart === 0 && el.selectionEnd === 0;
      const atEnd = el.selectionStart === el.value.length && el.selectionEnd === el.value.length;
      if ((event.key === "ArrowUp" && (atStart || atEnd)) || (event.key === "ArrowDown" && atEnd)) {
        event.preventDefault();
        setHistoryIndex((index) => {
          const next =
            index === null
              ? 0
              : event.key === "ArrowUp"
                ? Math.min(index + 1, history.length - 1)
                : Math.max(index - 1, -1);
          const entry = next >= 0 ? (history[next] ?? "") : "";
          setText(entry);
          return next;
        });
      }
    }
    // "/" at the start opens the library picker.
    if (event.key === "/" && text === "" && !pickerOpen) {
      setPickerOpen(true);
      setPickerQuery("");
    }
  };

  const insertLibraryPrompt = (entry: PromptEntry) => {
    setText((current) => (current === "/" ? entry.body : `${current}${entry.body}`));
    setPickerOpen(false);
    void prompts()
      .used(entry.id)
      .catch(() => {});
    inputRef.current?.focus();
  };

  if (!bar?.open) return null;

  const taskGroups = new Map<string, Target[]>();
  for (const target of targets) {
    const key = target.taskId ?? "";
    taskGroups.set(key, [...(taskGroups.get(key) ?? []), target]);
  }

  return (
    <div
      ref={barRef}
      role="dialog"
      aria-label={t("promptBar.title")}
      data-prompt-bar
      className="absolute inset-x-0 top-10 z-40 mx-auto flex max-w-2xl flex-col gap-2 rounded-xl border border-border bg-surface p-3 shadow-xl"
    >
      <div className="flex flex-wrap items-center gap-1.5">
        {targets.length === 0 && <span className="text-xs text-muted">{t("promptBar.noAgents")}</span>}
        {[...taskGroups.entries()].map(([taskId, members]) => {
          const allSelected = members.every((m) => selected.has(m.sessionId));
          const taskName = taskNameOf(taskId || null) ?? t("promptBar.thisTask");
          return (
            <button
              key={taskId || "none"}
              type="button"
              data-target-chip={taskId || "none"}
              aria-pressed={allInTask || allSelected}
              className={cn(
                "rounded-full border px-2 py-0.5 text-xs",
                allInTask || allSelected ? "border-accent bg-accent/15 text-fg" : "border-border text-muted",
              )}
              onClick={() => {
                if (taskId) {
                  setAllInTask((on) => {
                    const next = !on;
                    if (next) {
                      setSelected(new Set(members.map((m) => m.sessionId)));
                    }
                    return next;
                  });
                } else {
                  setSelected((current) => {
                    const next = new Set(current);
                    for (const m of members) next.has(m.sessionId) ? next.delete(m.sessionId) : next.add(m.sessionId);
                    return next;
                  });
                }
              }}
            >
              {members.length > 1 ? `${taskName} (${members.length})` : members[0]?.label}
            </button>
          );
        })}
        {taskGroups.size > 1 && (
          <button
            type="button"
            data-target-all
            aria-pressed={allInTask}
            className={cn(
              "rounded-full border px-2 py-0.5 text-xs",
              allInTask ? "border-accent bg-accent/15 text-fg" : "border-border text-muted",
            )}
            onClick={() => setAllInTask((on) => !on)}
          >
            {t("promptBar.allInTask")}
          </button>
        )}
      </div>
      <div className="relative">
        <textarea
          ref={inputRef}
          value={text}
          onChange={(event) => {
            setText(event.target.value);
            setHistoryIndex(null);
          }}
          onKeyDown={onKeyDown}
          rows={3}
          placeholder={t("promptBar.placeholder")}
          aria-label={t("promptBar.input")}
          data-prompt-input
          className="w-full resize-none rounded-lg border border-border bg-term-bg px-3 py-2 text-sm text-fg outline-none focus:border-accent"
        />
        {pickerOpen && (
          <div
            data-prompt-picker
            className="absolute inset-x-0 top-full z-10 mt-1 max-h-56 overflow-y-auto rounded-lg border border-border bg-surface shadow-lg"
          >
            <div className="border-b border-border p-1.5">
              <input
                value={pickerQuery}
                onChange={(event) => setPickerQuery(event.target.value)}
                placeholder={t("promptBar.searchPrompts")}
                aria-label={t("promptBar.searchPrompts")}
                className="w-full rounded-md bg-term-bg px-2 py-1 text-sm outline-none"
                ref={(el) => el?.focus()}
              />
            </div>
            {library.length === 0 && <div className="px-3 py-2 text-xs text-muted">{t("promptBar.noPrompts")}</div>}
            {library.map((entry) => (
              <button
                key={entry.id}
                type="button"
                data-prompt-option={entry.id}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-start text-sm hover:bg-surface-2"
                onClick={() => insertLibraryPrompt(entry)}
              >
                <span className="truncate font-medium">{entry.name}</span>
                <span className="truncate text-xs text-muted">{entry.body}</span>
                <span className="ms-auto shrink-0 text-xs text-muted">×{entry.uses}</span>
              </button>
            ))}
          </div>
        )}
      </div>
      <div className="flex items-center gap-2">
        <span className="text-xs text-muted">
          {effectiveTargets.length} {t("promptBar.targetsCount")}
        </span>
        <span className="flex-1" />
        <span className="text-xs text-muted">Esc</span>
        <Button
          size="sm"
          variant="primary"
          disabled={!text.trim() || effectiveTargets.length === 0}
          onClick={() => void send()}
        >
          {t("promptBar.send")}
        </Button>
      </div>
    </div>
  );
}
