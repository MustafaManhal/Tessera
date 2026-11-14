// The S-16 "Needs you" inbox (brief 32): a status-bar button with the unread count opening a popover of recent
// attention events — source icon, task, message, time ago — unread first. Click jumps to the pane and marks the
// row read; "Mark all read" and "Clear all" manage the list. The DND row sets `notifications.dnd-until`.
import { Button, cn, EmptyState, IconButton, Icons, type LucideIcon, Switch, t } from "@tessera/ui";
import { useCallback, useEffect, useRef, useState } from "react";
import { AgentIcon } from "../agents/AgentIcon";
import { openTaskTab } from "../sidebar/taskTabs";
import { primaryShortcut } from "../actions/registry";
import { getPlatform } from "@tessera/ui";
import { store } from "../store";
import { layout } from "../store/layoutSlice";
import { requestPaneFocus, setInboxOpen } from "../store/uiSlice";
import { useAppDispatch, useAppSelector } from "../store/hooks";
import { DND_INDEFINITE, dndActive, dndUntil, setDndUntil } from "./dnd";
import { inbox, type InboxEntry } from "./inbox";

const LIST_LIMIT = 50;

function timeAgo(at: number, now: number): string {
  const seconds = Math.max(0, now - at);
  if (seconds < 60) return t("inbox.timeAgo.now");
  if (seconds < 3600) return t("inbox.timeAgo.minutes", { count: Math.floor(seconds / 60) });
  if (seconds < 86400) return t("inbox.timeAgo.hours", { count: Math.floor(seconds / 3600) });
  return t("inbox.timeAgo.days", { count: Math.floor(seconds / 86400) });
}

// Static references: a lookup by name in the whole `Icons` namespace would pull every lucide icon into the start bundle.
const SOURCE_ICON: Record<string, LucideIcon> = {
  agent: Icons.Bot,
  command: Icons.Terminal,
  ci: Icons.GitPullRequest,
  automation: Icons.Zap,
  update: Icons.ArrowUp,
};

function tomorrowEight(): number {
  const date = new Date();
  date.setDate(date.getDate() + 1);
  date.setHours(8, 0, 0, 0);
  return Math.floor(date.getTime() / 1000);
}

function InboxRow({ entry, taskName, onJump }: { entry: InboxEntry; taskName: string | null; onJump: () => void }) {
  const SourceIcon = SOURCE_ICON[entry.source] ?? Icons.Bell;
  const now = Math.floor(Date.now() / 1000);
  return (
    <button
      type="button"
      data-inbox-entry={entry.id}
      data-read={entry.isRead}
      className={cn(
        "flex w-full items-start gap-2 px-3 py-2 text-start hover:bg-surface-2",
        !entry.isRead && "bg-surface-2/60",
      )}
      onClick={onJump}
    >
      <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center text-muted" aria-hidden>
        {entry.source === "agent" ? (
          <AgentIcon name={entry.title.split(" ")[0] ?? "bot"} size={14} />
        ) : (
          <SourceIcon size={14} />
        )}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-2">
          <span className={cn("truncate text-sm", !entry.isRead && "font-medium")}>{entry.title}</span>
          <span className="ms-auto shrink-0 text-xs text-muted">{timeAgo(entry.at, now)}</span>
        </span>
        <span className="block truncate text-xs text-muted">
          {taskName ? `${taskName} · ` : ""}
          {entry.body}
        </span>
      </span>
      {!entry.isRead && <span aria-hidden className="mt-1.5 size-1.5 shrink-0 rounded-full bg-accent" />}
    </button>
  );
}

export function InboxButton({ labeled = false }: { labeled?: boolean }) {
  const dispatch = useAppDispatch();
  const open = useAppSelector((state) => state.ui.inboxOpen);
  const version = useAppSelector((state) => state.ui.inboxVersion);
  const tasks = useAppSelector((state) => state.projects.tasks);
  const platform = getPlatform();
  const [unread, setUnread] = useState(0);
  const [entries, setEntries] = useState<InboxEntry[]>([]);
  const [dnd, setDnd] = useState(dndActive());
  const panelRef = useRef<HTMLDivElement>(null);

  // DEV/test hook: ?inbox=1 opens the popover on load (used by audit-ui and screenshots).
  useEffect(() => {
    if (import.meta.env.DEV && new URLSearchParams(window.location.search).has("inbox")) {
      dispatch(setInboxOpen(true));
    }
  }, [dispatch]);

  const refresh = useCallback(async () => {
    const list = await inbox().list(LIST_LIMIT);
    setEntries(list);
    setUnread(list.filter((entry) => !entry.isRead).length);
  }, []);

  // `version` (a new inbox row) and `open` (the popover opening) both refetch.
  // biome-ignore lint/correctness/useExhaustiveDependencies: version and open are refetch triggers.
  useEffect(() => {
    void refresh().catch(() => {});
    setDnd(dndActive());
  }, [refresh, version, open]);

  // Close on Escape and on outside clicks.
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") dispatch(setInboxOpen(false));
    };
    const onDown = (event: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(event.target as Node)) dispatch(setInboxOpen(false));
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onDown);
    };
  }, [open, dispatch]);

  const markAll = async () => {
    await inbox()
      .markRead(null)
      .catch(() => {});
    await refresh();
  };
  const clear = async () => {
    await inbox()
      .clear()
      .catch(() => {});
    await refresh();
  };

  const jump = async (entry: InboxEntry) => {
    // Agent rows resolve pane_session_id → agent session → pane; command rows jump to their task tab.
    const state = store.getState();
    let paneId: string | null = null;
    if (entry.paneSessionId) {
      paneId =
        Object.values(state.agentSessions.sessions).find((s) => s.pane_session_id === entry.paneSessionId)?.pane_id ??
        null;
    }
    if (paneId && state.layout.panes[paneId]) {
      const taskId = state.layout.panes[paneId]?.taskId ?? entry.taskId;
      if (taskId) void dispatch(openTaskTab(taskId));
      dispatch(layout({ type: "pane/focus", paneId }));
      dispatch(requestPaneFocus());
    } else if (entry.taskId) {
      void dispatch(openTaskTab(entry.taskId));
    }
    if (!entry.isRead) {
      await inbox()
        .markRead([entry.id])
        .catch(() => {});
      await refresh();
    }
    dispatch(setInboxOpen(false));
  };

  const chooseDnd = async (until: number) => {
    await setDndUntil(until).catch(() => {});
    setDnd(dndActive());
  };

  const dndLabel = (() => {
    const until = dndUntil();
    if (until >= DND_INDEFINITE) return t("dnd.untilOff");
    const date = new Date(until * 1000);
    return t("dnd.until", { time: date.toLocaleString(undefined, { hour: "numeric", minute: "2-digit" }) });
  })();

  return (
    <div className={cn("relative", labeled && "w-full")} ref={panelRef}>
      <span className={cn("relative inline-flex", labeled && "w-full")}>
        {labeled ? (
          <Button
            variant="ghost"
            icon={Icons.Bell}
            className={cn("w-full justify-start", unread > 0 && "text-accent")}
            title={primaryShortcut("attention.inbox", platform) || undefined}
            data-inbox-button
            onClick={() => dispatch(setInboxOpen(!open))}
          >
            {t("inbox.title")}
          </Button>
        ) : (
          <IconButton
            icon={Icons.Bell}
            label={t("statusBar.needsYou")}
            shortcut={primaryShortcut("attention.inbox", platform)}
            size="sm"
            className={cn("-my-px", unread > 0 && "text-accent")}
            data-inbox-button
            onClick={() => dispatch(setInboxOpen(!open))}
          />
        )}
        {unread > 0 && (
          <span
            aria-hidden
            className="pointer-events-none absolute -top-0.5 -end-0.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-st-needs px-0.5 text-[9px] font-semibold text-white"
            data-inbox-count
          >
            {unread > 99 ? "99+" : unread}
          </span>
        )}
      </span>
      {open && (
        <div
          role="dialog"
          aria-label={t("inbox.title")}
          data-inbox-panel
          className={cn(
            "absolute bottom-full z-50 mb-1 flex max-h-[28rem] w-96 max-w-[calc(100vw-2rem)] flex-col overflow-hidden rounded-lg border border-border bg-surface shadow-lg",
            labeled ? "start-0" : "end-0",
          )}
        >
          <div className="flex items-center gap-2 border-b border-border px-3 py-2">
            <span className="flex-1 text-sm font-medium">{t("inbox.title")}</span>
            {unread > 0 && <span className="text-xs text-muted">{t("inbox.unread", { count: unread })}</span>}
            <Button size="sm" variant="ghost" onClick={() => void markAll()} disabled={unread === 0}>
              {t("inbox.markAllRead")}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => void clear()} disabled={entries.length === 0}>
              {t("inbox.clear")}
            </Button>
          </div>
          <div className="border-b border-border px-3 py-2" data-dnd-row>
            <div className="flex items-center gap-2">
              <Switch
                checked={dnd}
                onCheckedChange={(on: boolean) => void chooseDnd(on ? Math.floor(Date.now() / 1000) + 30 * 60 : 0)}
                aria-label={t("dnd.title")}
              />
              <span className="text-sm">{t("dnd.title")}</span>
              {dnd && <span className="text-xs text-muted">{dndLabel}</span>}
            </div>
            <div className="mt-1 flex flex-wrap gap-1">
              {dnd ? (
                <>
                  <Button size="sm" variant="ghost" onClick={() => void chooseDnd(DND_INDEFINITE)}>
                    {t("dnd.untilOff")}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => void chooseDnd(0)}>
                    {t("dnd.off")}
                  </Button>
                </>
              ) : (
                <>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => void chooseDnd(Math.floor(Date.now() / 1000) + 30 * 60)}
                  >
                    {t("dnd.30min")}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => void chooseDnd(Math.floor(Date.now() / 1000) + 3600)}
                  >
                    {t("dnd.1h")}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => void chooseDnd(tomorrowEight())}>
                    {t("dnd.tomorrow")}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => void chooseDnd(DND_INDEFINITE)}>
                    {t("dnd.untilOff")}
                  </Button>
                </>
              )}
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {entries.length === 0 ? (
              <EmptyState icon={Icons.Bell} message={t("inbox.empty")} />
            ) : (
              entries.map((entry) => (
                <InboxRow
                  key={entry.id}
                  entry={entry}
                  taskName={entry.taskId ? (tasks[entry.taskId]?.name ?? null) : null}
                  onJump={() => void jump(entry)}
                />
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
