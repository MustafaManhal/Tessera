// What a pane shows by kind: a terminal for shells and run scripts, the agent pane (terminal plus launch header) for
// agents, and the setup pane (terminal plus the script approval card) for `setup` panes. The layout code only knows
// `PaneContent`; this is the one component the app passes to it.
import type { Ref } from "react";
import { SetupPane } from "../sidebar/SetupPane";
import type { PaneContentHandle, PaneContentProps } from "../shell/pane/PaneContent";
import { AgentPane } from "../agents/AgentPane";
import { TerminalPane } from "./TerminalPane";

export function PaneRouter(props: PaneContentProps & { ref?: Ref<PaneContentHandle> }) {
  if (props.kind === "agent") return <AgentPane {...props} />;
  return props.kind === "setup" ? <SetupPane {...props} /> : <TerminalPane {...props} />;
}
