// The attention side effects of `agent:session_changed` (brief 32): debounce, gates, mark, notify, record.
// Wired from listeners.ts on every sessionUpserted; pure decisions live in attention.ts for unit tests.
import { t } from "@tessera/ui";
import { notifications } from "../notify";
import { isPaneLookedAt } from "../notify/service";
import { inbox } from "../notify/inbox";
import type { AppDispatch, RootState } from "../store";
import { clearAgentAttention, setAgentAttention } from "../store/attentionSlice";
import { bumpInbox } from "../store/uiSlice";
import type { AgentSession } from "./types";
import { ATTENTION_DEBOUNCE_MS, type AttentionKind, attentionConfigKey, attentionKind, configValue } from "./attention";

interface Api {
  getState(): RootState;
  dispatch: AppDispatch;
}

/** Pending debounced marks, keyed by agent session id (a session can only hold one). */
const pending = new Map<string, ReturnType<typeof setTimeout>>();

function cancel(sessionId: string): void {
  const timer = pending.get(sessionId);
  if (timer) clearTimeout(timer);
  pending.delete(sessionId);
}

/** The project mute for a task id: task → project → is_muted. Unknown tasks are not muted. */
export function projectMuted(state: RootState, taskId: string | null): boolean {
  if (!taskId) return false;
  const task = state.projects.tasks[taskId];
  if (!task) return false;
  return state.projects.projects[task.project_id]?.is_muted === true;
}

/** The config switch for a kind; missing config means the default (on). */
function settingOn(state: RootState, kind: AttentionKind): boolean {
  const value = configValue(state.config.values, `notifications.${attentionConfigKey(kind)}`);
  return typeof value === "boolean" ? value : true;
}

/** Re-checks every gate at fire time — the world may have changed during the debounce. */
function stillRelevant(state: RootState, session: AgentSession, kind: AttentionKind): boolean {
  if (!session.pane_id || !state.layout.panes[session.pane_id]) return false;
  if (session.status !== (kind === "needs_input" ? "needs_input" : "idle")) return false;
  if (isPaneLookedAt(state, session.pane_id)) return false;
  if (projectMuted(state, session.task_id)) return false;
  if (!settingOn(state, kind)) return false;
  return true;
}

function fire(api: Api, sessionId: string, kind: AttentionKind): void {
  pending.delete(sessionId);
  const state = api.getState();
  const session = state.agentSessions.sessions[sessionId];
  if (!session || !stillRelevant(state, session, kind)) return;
  const paneId = session.pane_id as string;
  const text = session.status_message?.trim() || "";
  api.dispatch(
    setAgentAttention({
      agentSessionId: session.id,
      kind,
      text,
      paneId,
      taskId: session.task_id,
      at: Date.now(),
    }),
  );
  // The OS notification goes through the usual service (throttled, permission-aware); DND is applied there.
  notifications().notify({
    paneId,
    title: "",
    body: text || t(kind === "needs_input" ? "attention.agentNeedsInput" : "attention.agentDone"),
    badge: "notification",
    source: "agent",
  });
  api.dispatch(bumpInbox());
  void inbox()
    .record({
      source: "agent",
      taskId: session.task_id,
      paneSessionId: session.pane_session_id,
      title: t("attention.inboxTitle", { agent: session.agent_id }),
      body: text || t(kind === "needs_input" ? "attention.agentNeedsInput" : "attention.agentDone"),
    })
    .catch(() => {});
}

/**
 * One session change in, attention decisions out. `previous` is the row before this change (undefined for a new
 * session). Marks are debounced per session; a session that moves on before the timer fires never pings.
 */
export function agentAttentionEffect(session: AgentSession, previous: AgentSession | undefined, api: Api): void {
  const kind = attentionKind(session.status, previous?.status);
  if (kind === null) {
    // The status moved on (working again, exited, ...): drop this session's pending mark and any live one.
    cancel(session.id);
    if (session.pane_id) {
      api.dispatch(clearAgentAttention({ paneId: session.pane_id, agentSessionId: session.id }));
    }
    return;
  }
  // Re-qualifying while a mark is pending restarts the debounce (the latest transition wins).
  cancel(session.id);
  const timer = setTimeout(() => fire(api, session.id, kind), ATTENTION_DEBOUNCE_MS);
  pending.set(session.id, timer);
}

/** Test hook: pending debounce timers (a leaked one would ping after the test). */
export function pendingAttention(): number {
  return pending.size;
}
