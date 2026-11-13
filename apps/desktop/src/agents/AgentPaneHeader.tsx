// The agent pane header (S-05/M6.2): who is running, its profile, the permissions warning, the session status, and Stop
// and Restart. Above the terminal, so the terminal keeps its whole grid. Keyboard reachable and labels carry shortcuts.
import { Button, getPlatform, Icons, StatusPill, t, Tooltip } from "@tessera/ui";
import type { Status, StringKey } from "@tessera/ui";
import { primaryShortcut } from "../actions/registry";
import { useAppDispatch, useAppSelector } from "../store/hooks";
import { usePtyClient } from "../terminal/ptyClient";
import { AgentLogo } from "./AgentLogo";
import { useEffect, useState } from "react";
import { registerAgentStopper, resumeAgentPane, restartAgentPane, stopAgentInPane, stopAgentPane } from "./launch";
import { selectLaunch, selectSession } from "./sessionsSlice";
import { HandoffDialog } from "../usage/HandoffDialog";
import { UsageChip } from "../usage/UsageChip";
import { agentsClient } from "./service";
import type { AgentStatus } from "./types";

const STATUS: Record<AgentStatus, { pill: Status; label: StringKey }> = {
  starting: { pill: "working", label: "agents.status.starting" },
  working: { pill: "working", label: "agents.status.working" },
  needs_input: { pill: "needs", label: "agents.status.needs" },
  idle: { pill: "off", label: "agents.status.idle" },
  error: { pill: "error", label: "agents.status.error" },
  exited: { pill: "done", label: "agents.status.exited" },
};

export function AgentPaneHeader({ paneId }: { paneId: string }) {
  const dispatch = useAppDispatch();
  const pty = usePtyClient();
  const launch = useAppSelector((state) => selectLaunch(state, paneId));
  const session = useAppSelector((state) => selectSession(state, paneId));
  const platform = getPlatform();
  const [supportsResume, setSupportsResume] = useState(false);
  const [handoff, setHandoff] = useState(false);
  const resumeError = useAppSelector((state) => state.agentSessions.resumeErrors?.[paneId]);
  useEffect(() => {
    let active = true;
    void agentsClient()
      .agentCatalog(false)
      .then((rows) => {
        if (active) setSupportsResume(!!rows.find((r) => r.id === launch?.agent_id)?.supports_resume);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [launch?.agent_id]);
  useEffect(() => {
    if (!pty) return;
    return registerAgentStopper(paneId, () => void dispatch(stopAgentPane(paneId, (id) => pty.kill(id))));
  }, [pty, paneId, dispatch]);
  if (!launch) return null;

  // An exit with a non-zero code is an error, not a finish.
  const viewed = session ? STATUS[session.status] : null;
  const pill: { pill: Status; label: StringKey } | null =
    session?.status === "exited" && session.exit_code ? { pill: "error", label: "agents.status.error" } : viewed;
  const canStop = !!session?.pane_session_id && session.status !== "exited";

  return (
    <div
      data-agent-header
      data-agent-id={launch.agent_id}
      data-agent-status={session?.status ?? "starting"}
      className="flex min-h-8 flex-wrap items-center gap-x-2 gap-y-1 border-b border-border bg-surface-2 px-2 py-1"
    >
      <AgentLogo agent={launch.agent_id} name={launch.agent_name} size={16} />
      <span className="text-sm font-medium">{launch.agent_name}</span>
      <span className="min-w-0 truncate text-xs text-muted" title={launch.profile_name}>
        {launch.profile_name}
      </span>
      {launch.skip_permissions && (
        <span
          data-agent-skip
          className="inline-flex items-center gap-1 rounded-sm bg-st-error-tint px-1 text-xs text-fg"
        >
          <Icons.TriangleAlert size={12} className="text-st-error" aria-hidden />
          {t("agents.skipBadge")}
        </span>
      )}
      {pill && <StatusPill status={pill.pill} label={t(pill.label)} data-agent-status-pill />}
      <UsageChip taskId={launch.task_id} refreshKey={session?.status} />
      <div className="ms-auto flex items-center gap-1">
        <Tooltip label={t("agents.stop")} shortcut={primaryShortcut("agents.stop", platform)}>
          <Button
            size="sm"
            variant="ghost"
            icon={Icons.Square}
            disabled={!canStop}
            onClick={() => {
              stopAgentInPane(paneId);
            }}
          >
            {t("agents.stop")}
          </Button>
        </Tooltip>
        {session?.status === "exited" && supportsResume && session.external_session_id && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              void dispatch(resumeAgentPane(paneId)).catch(() => {});
            }}
          >
            {t("agents.resume")}
          </Button>
        )}
        {resumeError && (
          <span role="alert" className="text-xs text-st-error">
            {resumeError}
          </span>
        )}
        {launch.task_id && (
          <Button size="sm" variant="ghost" data-agent-handoff onClick={() => setHandoff(true)}>
            {t("handoff.action")}
          </Button>
        )}
        <Tooltip label={t("agents.restart")} shortcut={primaryShortcut("agents.restart", platform)}>
          <Button
            size="sm"
            variant="ghost"
            icon={Icons.RotateCcw}
            onClick={() => void dispatch(restartAgentPane(paneId))}
          >
            {t("agents.restart")}
          </Button>
        </Tooltip>
      </div>
      {handoff && launch.task_id && (
        <HandoffDialog taskId={launch.task_id} currentAgentId={launch.agent_id} onClose={() => setHandoff(false)} />
      )}
    </div>
  );
}
