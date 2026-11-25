// "Install" for an agent that is not on this computer: shows the exact command for this platform, a Copy button, and
// an Install button that runs it (output on failure), then asks the page to rescan so the agent shows as installed.
import { Button, Icons, t } from "@tessera/ui";
import { useState } from "react";
import { agentsErrorMessage } from "./errors";
import { agentsClient } from "./service";
import type { AgentInfo } from "./types";

export function InstallPanel({ agent, onInstalled }: { agent: AgentInfo; onInstalled: () => void | Promise<void> }) {
  const [running, setRunning] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const command = agent.install_command;

  const install = async () => {
    if (running) return;
    setRunning(true);
    setFailure(null);
    try {
      const result = await agentsClient().agentInstall(agent.id);
      if (result.ok) await onInstalled();
      else setFailure(result.output || t("agents.installFailed", { name: agent.name }));
    } catch (cause) {
      setFailure(agentsErrorMessage(cause));
    } finally {
      setRunning(false);
    }
  };

  const copy = () => {
    if (!command) return;
    void navigator.clipboard
      .writeText(command)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => {});
  };

  return (
    <div data-install-panel className="flex flex-col gap-2 rounded-lg bg-surface-2 p-3 text-sm">
      <p>{t(command ? "agents.installIntro" : "agents.installHint", { name: agent.name })}</p>
      {command && (
        <div className="flex items-center gap-2">
          <code
            data-install-command
            className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap rounded-md bg-surface px-2 py-1.5 font-mono text-xs"
          >
            {command}
          </code>
          <Button size="sm" variant="ghost" icon={copied ? Icons.Check : Icons.Copy} onClick={copy} data-copy-install>
            {t(copied ? "agents.copied" : "agents.copy")}
          </Button>
          <Button size="sm" icon={Icons.Download} loading={running} onClick={() => void install()} data-run-install>
            {t(running ? "agents.installing" : "agents.install")}
          </Button>
        </div>
      )}
      {failure && (
        <pre
          role="alert"
          data-install-failure
          className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-md bg-st-error-tint p-2 font-mono text-xs text-fg"
        >
          {failure}
        </pre>
      )}
    </div>
  );
}
