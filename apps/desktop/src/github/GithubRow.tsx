// S-18 GitHub section of Settings → General (FR-54): connect by device code or `gh` import; shows login/scopes and
// disconnects with an in-app confirmation. Rate-limit notice surfaces when the backend reports `until`.
import { Button, Dialog, DialogContent, DialogFooter, DialogTitle, t } from "@tessera/ui";
import { useEffect, useState } from "react";
import { openExternal } from "../terminal/open";
import { githubClient, type GithubIntegration } from "./client";

export function GithubRow() {
  const [integration, setIntegration] = useState<GithubIntegration | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [connecting, setConnecting] = useState<null | "device" | "gh">(null);
  const [code, setCode] = useState<{
    userCode: string;
    verificationUri: string;
    deviceCode: string;
    interval: number;
  } | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rateLimitedUntil, setRateLimitedUntil] = useState<number | null>(null);

  useEffect(() => {
    void githubClient()
      .status()
      .then(setIntegration)
      .catch(() => {})
      .finally(() => setLoaded(true));
  }, []);

  const startDevice = async () => {
    setError(null);
    try {
      const start = await githubClient().connectStart();
      setCode(start);
      setConnecting("device");
      // window.open does nothing inside the app: go through the system browser.
      void openExternal(start.verificationUri);
      // Poll until connected, cancelled, or the code expires (~15 min cap).
      const deadline = Date.now() + 15 * 60_000;
      const interval = Math.max(1, start.interval);
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, interval * 1000));
        const result = await githubClient().connectPoll(start.deviceCode);
        if (result) {
          setIntegration(result);
          setConnecting(null);
          setCode(null);
          return;
        }
      }
      setConnecting(null);
      setCode(null);
      setError(t("github.expired"));
    } catch (cause) {
      setConnecting(null);
      const message = cause instanceof Error ? cause.message : String(cause);
      const until = /rate limited until (\d+)/.exec(message)?.[1];
      if (until) setRateLimitedUntil(Number(until));
      setError(message);
    }
  };

  const importGh = async () => {
    setError(null);
    setConnecting("gh");
    try {
      setIntegration(await githubClient().importGh());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setConnecting(null);
    }
  };

  const disconnect = async () => {
    setConfirming(false);
    await githubClient().disconnect();
    setIntegration(null);
  };

  if (!loaded) return null;
  return (
    <div className="flex flex-col gap-2" data-github-row>
      <div className="text-sm font-medium">{t("github.title")}</div>
      <p className="text-xs text-muted">{t("github.explain")}</p>
      {integration ? (
        <div className="flex items-center gap-2">
          <span className="text-sm">{integration.login}</span>
          <span className="text-xs text-muted">{integration.scopes}</span>
          <Button size="sm" variant="ghost" onClick={() => setConfirming(true)}>
            {t("github.disconnect")}
          </Button>
        </div>
      ) : (
        <div className="flex items-center gap-2">
          <Button size="sm" variant="primary" disabled={connecting !== null} onClick={() => void startDevice()}>
            {connecting === "device" ? t("github.waiting") : t("github.connect")}
          </Button>
          <Button size="sm" variant="ghost" disabled={connecting !== null} onClick={() => void importGh()}>
            {t("github.useGh")}
          </Button>
        </div>
      )}
      {connecting === "device" && code && (
        <div className="flex flex-col gap-1 rounded-md border border-border p-2" data-device-code>
          <div className="text-lg font-mono tracking-widest" data-user-code>
            {code.userCode}
          </div>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => void navigator.clipboard?.writeText(code.userCode).catch(() => {})}
            >
              {t("github.copyCode")}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => void openExternal(code.verificationUri)}>
              {t("github.openGithub")}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setConnecting(null);
                setCode(null);
              }}
            >
              {t("github.cancel")}
            </Button>
          </div>
        </div>
      )}
      {rateLimitedUntil && rateLimitedUntil * 1000 > Date.now() && (
        <p className="text-xs text-warn">
          {t("github.rateLimited", { time: new Date(rateLimitedUntil * 1000).toLocaleTimeString() })}
        </p>
      )}
      {error && (
        <p className="text-xs text-danger" data-github-error>
          {error}
        </p>
      )}
      <Dialog open={confirming} onOpenChange={(open) => !open && setConfirming(false)}>
        <DialogContent className="w-80">
          <DialogTitle>{t("github.disconnectTitle")}</DialogTitle>
          <p className="text-sm text-muted">{t("github.disconnectBody", { login: integration?.login ?? "" })}</p>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setConfirming(false)}>
              {t("button.cancel")}
            </Button>
            <Button variant="danger" onClick={() => void disconnect()}>
              {t("github.disconnect")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
