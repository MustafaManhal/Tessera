// The agent status on a sidebar task row (brief 31): a pill from the task's newest agent session, the latest
// message as a truncated secondary line (full text in the tooltip), and a small agent icon per live session.
import { StatusPill, t, type Status, type StringKey } from "@tessera/ui";
import { useAppSelector } from "../store/hooks";
import { AgentLogo } from "../agents/AgentLogo";
import type { AgentSession } from "../agents/types";

const PILL: Record<AgentSession["status"], { pill: Status; label: StringKey }> = {
  starting: { pill: "working", label: "agents.status.starting" },
  working: { pill: "working", label: "agents.status.working" },
  needs_input: { pill: "needs", label: "agents.status.needs" },
  idle: { pill: "off", label: "agents.status.idle" },
  error: { pill: "error", label: "agents.status.error" },
  exited: { pill: "done", label: "agents.status.exited" },
};

/** Newest session first; sessions share `started_at` ties rarely, so id order is the tiebreak. */
function newestFirst(a: AgentSession, b: AgentSession): number {
  return b.started_at - a.started_at || b.id.localeCompare(a.id);
}

/** The status words a screen reader hears on the task row ("Needs you: Approve the edit?"), or null without an agent. */
export function useTaskAgentSummary(taskId: string): string | null {
  const sessions = useAppSelector((state) => state.agentSessions.sessions);
  const newest = Object.values(sessions)
    .filter((session) => session.task_id === taskId)
    .sort(newestFirst)[0];
  if (!newest) return null;
  const label = t(PILL[newest.status].label);
  const message = newest.status_message?.trim();
  return message ? `${label}: ${message}` : label;
}

export function TaskAgentStatus({ taskId }: { taskId: string }) {
  // Stable record references: the slice only replaces entries, so these selectors are cheap.
  const sessions = useAppSelector((state) => state.agentSessions.sessions);
  const launches = useAppSelector((state) => state.agentSessions.launches);
  const taskSessions = Object.values(sessions)
    .filter((session) => session.task_id === taskId)
    .sort(newestFirst);
  const newest = taskSessions[0] ?? null;
  const liveIds = new Set(taskSessions.filter((s) => s.ended_at === null).map((s) => s.id));
  // Agent icons come from the launch plans, which carry the definition's icon name.
  const live = Object.values(launches)
    .filter((launch) => liveIds.has(launch.agent_session_id))
    .map((launch) => ({ id: launch.agent_id, name: launch.agent_name }));
  if (!newest) return null;
  const meta = PILL[newest.status];
  const label = t(meta.label);
  const message = newest.status_message?.trim() || null;
  return (
    <div className="flex min-w-0 items-center gap-1.5" data-task-agent-status={newest.status}>
      {live.map((agent, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: logos are positional duplicates at most.
        <AgentLogo key={index} agent={agent.id} name={agent.name} size={14} />
      ))}
      <StatusPill status={meta.pill} label={label} />
      {message && (
        <span className="min-w-0 flex-1 truncate text-xs text-muted" title={message}>
          {message}
        </span>
      )}
    </div>
  );
}
