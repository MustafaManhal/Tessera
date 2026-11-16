// The "Command-line tool" row on Settings → General (M6.3): install status, Install/Remove with confirmation, and —
// when the target folder is not on PATH — the exact line to add plus a Copy button. The install only ever runs from
// an explicit click here.
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
  getPlatform,
  Icons,
  type StringKey,
  t,
  useToast,
} from "@tessera/ui";
import { useEffect, useState } from "react";
import { cliClient } from "../cli/service";
import type { CliInstall } from "../cli/types";

export function CliRow() {
  const [status, setStatus] = useState<CliInstall | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [copied, setCopied] = useState(false);
  const { toast } = useToast();
  const platform = getPlatform();

  useEffect(() => {
    let cancelled = false;
    void cliClient()
      .cliInstallStatus()
      .then((next) => !cancelled && setStatus(next))
      .catch(() => !cancelled && setStatus(null));
    return () => {
      cancelled = true;
    };
  }, []);

  const run = async (work: () => Promise<CliInstall>) => {
    setBusy(true);
    try {
      setStatus(await work());
    } catch (cause) {
      toast({ title: cause instanceof Error ? cause.message : String(cause), kind: "error" });
    } finally {
      setBusy(false);
    }
  };

  const statusText = !status
    ? null
    : !status.installed
      ? t("cli.status.notInstalled")
      : !status.on_path
        ? t("cli.status.offPath")
        : status.path
          ? t("cli.status.installedAt", { path: status.path })
          : t("cli.status.installedAt", { path: status.target });

  const pathLine = platform === "mac" ? t("cli.pathLine") : null;

  return (
    <div data-setting="cli.install" className="flex flex-col gap-2 border-b border-border py-4">
      <div className="flex items-center justify-between gap-4">
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="text-base font-medium">{t("settings.cli")}</span>
          <span className="text-sm text-muted">{t("settings.cli.hint")}</span>
          {statusText && (
            <span className="text-sm" data-cli-status>
              {statusText}
            </span>
          )}
        </div>
        <div className="flex shrink-0 gap-1">
          {status?.installed ? (
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => setConfirmRemove(true)}>
              {t("cli.remove")}
            </Button>
          ) : (
            <Button
              size="sm"
              icon={Icons.Download}
              disabled={busy || !status}
              onClick={() => void run(() => cliClient().cliInstall())}
            >
              {t("cli.install")}
            </Button>
          )}
        </div>
      </div>
      {status?.installed && !status.on_path && (
        <div className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-surface-2 px-2 py-1.5">
          <span className="min-w-0 flex-1 text-sm text-muted">
            {pathLine ? `${t("cli.pathHint.mac")} ${pathLine}` : t("cli.pathHint.win")}
          </span>
          {pathLine && (
            <Button
              size="sm"
              variant="ghost"
              icon={copied ? Icons.Check : Icons.Copy}
              onClick={() => {
                void navigator.clipboard.writeText(pathLine).then(() => {
                  setCopied(true);
                  toast({ title: t("cli.copied") });
                  setTimeout(() => setCopied(false), 1500);
                });
              }}
            >
              {t("cli.copyPath")}
            </Button>
          )}
        </div>
      )}
      <Dialog open={confirmRemove} onOpenChange={setConfirmRemove}>
        <DialogContent>
          <DialogTitle>{t("cli.removeTitle")}</DialogTitle>
          <DialogDescription>{t("cli.removeBody")}</DialogDescription>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setConfirmRemove(false)}>
              {t("agents.hooks.cancel")}
            </Button>
            <Button
              variant="danger"
              disabled={busy}
              onClick={() => {
                setConfirmRemove(false);
                void run(() => cliClient().cliUninstall());
              }}
            >
              {t("cli.remove")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export type { CliInstall, StringKey };
