// An `agent` pane: the launch header (agent, profile, permissions, status, Stop/Restart) above the same terminal a
// shell pane uses. The PTY is the agent's program (PaneInfo.launch), delivered by launch.ts.
import type { Ref } from "react";
import type { PaneContentHandle, PaneContentProps } from "../shell/pane/PaneContent";
import { TerminalPane } from "../terminal/TerminalPane";
import { AgentPaneHeader } from "./AgentPaneHeader";

export function AgentPane(props: PaneContentProps & { ref?: Ref<PaneContentHandle> }) {
  return (
    <div className="flex h-full min-h-0 w-full flex-col">
      <AgentPaneHeader paneId={props.paneId} />
      <div className="min-h-0 flex-1">
        <TerminalPane {...props} />
      </div>
    </div>
  );
}
