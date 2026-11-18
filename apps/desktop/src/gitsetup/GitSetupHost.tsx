// Git on this computer: checked once on start, and from the palette ("Check for git"). Projects, tasks and worktrees
// all need git, so when it is missing the dialog says so and offers to install it: winget on Windows, Apple's command
// line developer tools on macOS, or the download page by hand.
import { commands, type GitSetup, unwrap } from "@tessera/ipc";
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
  getPlatform,
  Icons,
  t,
} from "@tessera/ui";
import { useCallback, useEffect, useState } from "react";
import { isNativeRuntime } from "../native/runtime";
import { GIT_MISSING_EVENT, GIT_SETUP_EVENT } from "./events";
import { openExternal } from "../terminal/open";

export function GitSetupHost() {
  const [open, setOpen] = useState(false);
  const [setup, setSetup] = useState<GitSetup | null>(null);
  const [checking, setChecking] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [waitingForApple, setWaitingForApple] = useState(false);
  const [copied, setCopied] = useState(false);
  const mac = getPlatform() === "mac";

  const check = useCallback(async () => {
    setChecking(true);
    try {
      const next = await unwrap(commands.gitSetupCheck());
      setSetup(next);
      if (next.installed) setWaitingForApple(false);
      return next;
    } catch {
      return null;
    } finally {
      setChecking(false);
    }
  }, []);

  useEffect(() => {
    if (isNativeRuntime()) {
      void check().then((next) => {
        if (next && !next.installed) setOpen(true);
      });
    }
    const onOpen = () => {
      setOpen(true);
      setFailure(null);
      void check();
    };
    const onMissing = () => {
      void check().then((next) => {
        if (next && !next.installed) setOpen(true);
      });
    };
    window.addEventListener(GIT_SETUP_EVENT, onOpen);
    window.addEventListener(GIT_MISSING_EVENT, onMissing);
    return () => {
      window.removeEventListener(GIT_SETUP_EVENT, onOpen);
      window.removeEventListener(GIT_MISSING_EVENT, onMissing);
    };
  }, [check]);

  const install = async () => {
    if (installing) return;
    setInstalling(true);
    setFailure(null);
    try {
      const result = await unwrap(commands.gitSetupInstall());
      // macOS: Apple's installer window is open now; it finishes on its own time.
      if (mac) setWaitingForApple(true);
      const next = await check();
      if (!next?.installed && !mac) setFailure(result.output || t("gitSetup.installFailed"));
    } catch (cause) {
      setFailure(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setInstalling(false);
    }
  };

  const copy = () => {
    if (!setup) return;
    void navigator.clipboard
      .writeText(setup.install_command)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => {});
  };

  const installed = setup?.installed === true;
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      {open && (
        <DialogContent className="max-w-lg" data-git-setup data-git-installed={installed}>
          <DialogTitle>{t(installed ? "gitSetup.readyTitle" : "gitSetup.missingTitle")}</DialogTitle>
          <DialogDescription>
            {installed
              ? t("gitSetup.ready", { version: setup?.version ?? "" })
              : t(mac ? "gitSetup.missingMac" : "gitSetup.missingWindows")}
          </DialogDescription>
          {setup && !installed && (
            <div className="flex flex-col gap-2 text-sm">
              <div className="flex items-center gap-2">
                <code
                  data-git-install-command
                  className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap rounded-md bg-surface-2 px-2 py-1.5 font-mono text-xs"
                >
                  {setup.install_command}
                </code>
                <Button size="sm" variant="ghost" icon={copied ? Icons.Check : Icons.Copy} onClick={copy}>
                  {t(copied ? "agents.copied" : "agents.copy")}
                </Button>
              </div>
              {waitingForApple && <p role="status">{t("gitSetup.appleInstaller")}</p>}
              {installing && !mac && <p role="status">{t("gitSetup.installingWindows")}</p>}
              {failure && (
                <pre
                  role="alert"
                  data-git-install-failure
                  className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-md bg-st-error-tint p-2 font-mono text-xs text-fg"
                >
                  {failure}
                </pre>
              )}
            </div>
          )}
          <DialogFooter>
            {installed ? (
              <Button onClick={() => setOpen(false)}>{t("gitSetup.done")}</Button>
            ) : (
              <>
                <Button variant="ghost" onClick={() => setOpen(false)}>
                  {t("gitSetup.later")}
                </Button>
                <Button
                  variant="ghost"
                  icon={Icons.ExternalLink}
                  onClick={() => setup && void openExternal(setup.download_url)}
                  disabled={!setup}
                >
                  {t("gitSetup.download")}
                </Button>
                <Button variant="ghost" icon={Icons.RefreshCw} loading={checking} onClick={() => void check()}>
                  {t("gitSetup.checkAgain")}
                </Button>
                <Button
                  icon={Icons.Download}
                  loading={installing}
                  disabled={!setup}
                  onClick={() => void install()}
                  data-git-install
                >
                  {t(installing ? "agents.installing" : "gitSetup.install")}
                </Button>
              </>
            )}
          </DialogFooter>
        </DialogContent>
      )}
    </Dialog>
  );
}
