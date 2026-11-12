// S-18 Linear section of Settings → General (FR-55): paste an API key, see the account name, disconnect with an in-app
// confirmation. The key goes to the OS keychain; the page never shows it again.
import { Button, Dialog, DialogContent, DialogFooter, DialogTitle, Input, t } from "@tessera/ui";
import { useEffect, useState } from "react";
import { issuesClient } from "./service";
import type { LinearAccount } from "./types";

export function LinearRow() {
  const [account, setAccount] = useState<LinearAccount | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    void issuesClient()
      .linearStatus()
      .then(setAccount)
      .catch(() => {})
      .finally(() => setLoaded(true));
  }, []);

  const connect = async () => {
    setBusy(true);
    setError(null);
    try {
      setAccount(await issuesClient().linearConnect(key));
      setKey("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };
  const disconnect = async () => {
    setConfirming(false);
    await issuesClient().linearDisconnect();
    setAccount(null);
  };

  if (!loaded) return null;
  return (
    <div className="flex flex-col gap-2" data-linear-row>
      <div className="text-sm font-medium">{t("linear.title")}</div>
      <p className="text-xs text-muted">{t("linear.explain")}</p>
      {account ? (
        <div className="flex items-center gap-2">
          <span className="text-sm" data-linear-account>
            {account.name}
          </span>
          <Button size="sm" variant="ghost" onClick={() => setConfirming(true)}>
            {t("linear.disconnect")}
          </Button>
        </div>
      ) : (
        <form
          className="flex items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (key.trim() !== "" && !busy) void connect();
          }}
        >
          <Input
            type="password"
            autoComplete="off"
            spellCheck={false}
            aria-label={t("linear.key")}
            placeholder={t("linear.key")}
            value={key}
            onChange={(event) => setKey(event.target.value)}
            className="max-w-64"
          />
          <Button size="sm" variant="primary" type="submit" disabled={busy || key.trim() === ""}>
            {busy ? t("linear.checking") : t("linear.connect")}
          </Button>
        </form>
      )}
      {error && (
        <p className="text-xs text-danger" role="alert" data-linear-error>
          {error}
        </p>
      )}
      <Dialog open={confirming} onOpenChange={(open) => !open && setConfirming(false)}>
        <DialogContent className="w-80">
          <DialogTitle>{t("linear.disconnectTitle")}</DialogTitle>
          <p className="text-sm text-muted">{t("linear.disconnectBody", { name: account?.name ?? "" })}</p>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setConfirming(false)}>
              {t("button.cancel")}
            </Button>
            <Button variant="danger" onClick={() => void disconnect()}>
              {t("linear.disconnect")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
