import { Button, Icons, t } from "@tessera/ui";
import { useState } from "react";
/** The CLI owns the MCP transport; configuring an agent is an explicit copy/paste action. */
export function McpCommand() {
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState(false);
  return (
    <div className="flex flex-col gap-2 border-b border-border pb-3" data-mcp-command>
      <p className="text-sm text-muted">{t("settings.mcpCommandHint")}</p>
      <div className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-surface-2 p-2">
        <code className="min-w-0 flex-1 select-text text-sm">tessera mcp</code>
        <Button
          size="sm"
          variant="ghost"
          icon={copied ? Icons.Check : Icons.Copy}
          onClick={() => {
            setError(false);
            void navigator.clipboard
              .writeText("tessera mcp")
              .then(() => setCopied(true))
              .catch(() => setError(true));
          }}
        >
          {t("settings.mcpCopy")}
        </Button>
      </div>
      {copied && !error && (
        <p role="status" className="text-sm text-muted">
          {t("settings.mcpCopied")}
        </p>
      )}
      {error && (
        <p role="alert" className="text-sm text-st-error">
          {t("settings.mcpCopyFailed")}
        </p>
      )}
    </div>
  );
}
