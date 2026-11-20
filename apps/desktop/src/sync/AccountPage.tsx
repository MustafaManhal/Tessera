// S-21 Account and sync (M11.2, FR-70…FR-72). Signed out: what sync does and "Sign in with GitHub" (device flow: a
// short code entered on github.com). Then the recovery key: created and shown once for a new account, or entered on
// another device. Signed in: what syncs, last sync, Sync now, sign out, delete all synced data. Everything in Tessera
// works without signing in.
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
  Input,
  Switch,
  t,
} from "@tessera/ui";
import { type FormEvent, useCallback, useEffect, useId, useRef, useState } from "react";
import { openExternal } from "../terminal/open";
import type { SyncDeviceCode, SyncStatus } from "./client";
import { syncClient } from "./service";

const message = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));
const DOC_LABEL: Record<string, Parameters<typeof t>[0]> = {
  settings: "sync.doc.settings",
  "agent-profiles": "sync.doc.agentProfiles",
  projects: "sync.doc.projects",
};

export function AccountPage() {
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [device, setDevice] = useState<SyncDeviceCode | null>(null);
  const [needsExistingKey, setNeedsExistingKey] = useState(false);
  const [newKey, setNewKey] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const polling = useRef(0);

  const reload = useCallback(async () => {
    try {
      setStatus(await syncClient().status());
    } catch (cause) {
      setError(message(cause));
    }
  }, []);

  useEffect(() => {
    void reload();
    return () => {
      polling.current += 1;
    };
  }, [reload]);

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (cause) {
      setError(message(cause));
    } finally {
      setBusy(false);
      void reload();
    }
  };

  const signIn = () =>
    run(async () => {
      const code = await syncClient().signInStart();
      setDevice(code);
      void openExternal(code.verification_uri);
      const generation = ++polling.current;
      let interval = code.interval;
      for (;;) {
        await new Promise((done) => setTimeout(done, interval * 1000));
        if (polling.current !== generation) return;
        const poll = await syncClient().signInPoll(code.device_code);
        if (poll.state === "slow_down") interval = poll.interval;
        if (poll.state === "failed") throw new Error(poll.message ?? t("sync.signInFailed"));
        if (poll.state === "signed_in") {
          setDevice(null);
          setNeedsExistingKey(poll.has_remote_data);
          return;
        }
      }
    });

  const cancelSignIn = () => {
    polling.current += 1;
    setDevice(null);
    setBusy(false);
  };

  if (!status) {
    return (
      <div className="px-6 pb-6 pt-2 text-sm text-muted" data-sync-page>
        {error ? t("sync.loadFailed", { message: error }) : t("sync.loading")}
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-4 overflow-y-auto px-6 pb-6 pt-2" data-sync-page>
      {error && (
        <p role="alert" className="rounded-lg bg-st-error-tint p-2 text-sm">
          {error}
        </p>
      )}

      {!status.signed_in && !device && (
        <section className="flex max-w-prose flex-col gap-2" data-sync-signed-out>
          <h3 className="text-base font-semibold">{t("sync.title")}</h3>
          <p className="text-sm text-muted">{t("sync.explain")}</p>
          <p className="text-sm text-muted">{t("sync.privacy")}</p>
          <div>
            <Button variant="primary" disabled={busy} onClick={() => void signIn()}>
              {t("sync.signIn")}
            </Button>
          </div>
        </section>
      )}

      {device && (
        <section className="flex max-w-prose flex-col gap-2" data-sync-device>
          <h3 className="text-base font-semibold">{t("sync.deviceTitle")}</h3>
          <p className="text-sm text-muted">{t("sync.deviceBody", { url: device.verification_uri })}</p>
          <p className="font-mono text-xl tracking-widest" data-sync-user-code>
            {device.user_code}
          </p>
          <div className="flex gap-2">
            <Button onClick={() => void openExternal(device.verification_uri)}>{t("sync.openGithub")}</Button>
            <Button variant="ghost" onClick={() => void navigator.clipboard?.writeText(device.user_code)}>
              {t("sync.copyCode")}
            </Button>
            <Button variant="ghost" onClick={cancelSignIn}>
              {t("form.cancel")}
            </Button>
          </div>
          <p className="text-xs text-muted" aria-live="polite">
            {t("sync.waiting")}
          </p>
        </section>
      )}

      {status.signed_in && !status.has_key && !newKey && (
        <RecoveryStep
          existing={needsExistingKey}
          busy={busy}
          onCreate={() =>
            run(async () => {
              setNewKey(await syncClient().recoveryCreate());
            })
          }
          onEnter={(key) => run(() => syncClient().recoveryEnter(key))}
          onSwitch={() => setNeedsExistingKey((value) => !value)}
        />
      )}

      {newKey && <ShowRecoveryKey value={newKey} onDone={() => setNewKey(null)} />}

      {status.signed_in && status.has_key && !newKey && (
        <section className="flex max-w-prose flex-col gap-3" data-sync-signed-in>
          <h3 className="text-base font-semibold">{t("sync.title")}</h3>
          <p className="text-sm text-muted">
            {status.last_sync_at
              ? t("sync.lastSync", { time: new Date(status.last_sync_at).toLocaleString() })
              : t("sync.neverSynced")}
          </p>
          {status.last_error && (
            <p role="alert" className="text-sm text-danger">
              {status.last_error}
            </p>
          )}
          <fieldset className="flex flex-col gap-2 border-0 p-0">
            <legend className="mb-1 text-sm font-medium">{t("sync.whatSyncs")}</legend>
            {status.available.map((doc) => (
              <DocSwitch
                key={doc}
                doc={doc}
                checked={status.docs.includes(doc)}
                onChange={(on) =>
                  void run(() =>
                    syncClient().setDocs(on ? [...status.docs, doc] : status.docs.filter((d) => d !== doc)),
                  )
                }
              />
            ))}
            <p className="text-xs text-muted">{t("sync.neverSynced.secrets")}</p>
          </fieldset>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="primary"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  await syncClient().syncNow();
                })
              }
            >
              {t("sync.now")}
            </Button>
            <Button variant="ghost" disabled={busy} onClick={() => void run(() => syncClient().signOut())}>
              {t("sync.signOut")}
            </Button>
            <Button variant="danger" disabled={busy} onClick={() => setConfirmDelete(true)}>
              {t("sync.deleteAll")}
            </Button>
          </div>
        </section>
      )}

      {confirmDelete && (
        <Dialog open onOpenChange={(open) => !open && setConfirmDelete(false)}>
          <DialogContent role="alertdialog">
            <DialogTitle>{t("sync.deleteTitle")}</DialogTitle>
            <DialogDescription>{t("sync.deleteBody")}</DialogDescription>
            <DialogFooter>
              <Button variant="ghost" onClick={() => setConfirmDelete(false)}>
                {t("form.cancel")}
              </Button>
              <Button
                variant="danger"
                onClick={() => {
                  setConfirmDelete(false);
                  void run(() => syncClient().deleteAll());
                }}
              >
                {t("sync.deleteAll")}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}

function DocSwitch({ doc, checked, onChange }: { doc: string; checked: boolean; onChange: (on: boolean) => void }) {
  const id = useId();
  return (
    <div className="flex items-center gap-2">
      <Switch id={id} checked={checked} onCheckedChange={onChange} data-sync-doc={doc} />
      <label htmlFor={id} className="text-sm">
        {t(DOC_LABEL[doc] ?? "sync.doc.settings")}
      </label>
    </div>
  );
}

function RecoveryStep({
  existing,
  busy,
  onCreate,
  onEnter,
  onSwitch,
}: {
  existing: boolean;
  busy: boolean;
  onCreate: () => void;
  onEnter: (key: string) => void;
  onSwitch: () => void;
}) {
  const [value, setValue] = useState("");
  const id = useId();
  if (!existing) {
    return (
      <section className="flex max-w-prose flex-col gap-2" data-sync-recovery-new>
        <h3 className="text-base font-semibold">{t("sync.recovery.newTitle")}</h3>
        <p className="text-sm text-muted">{t("sync.recovery.newBody")}</p>
        <div className="flex gap-2">
          <Button variant="primary" disabled={busy} onClick={onCreate}>
            {t("sync.recovery.create")}
          </Button>
          <Button variant="ghost" onClick={onSwitch}>
            {t("sync.recovery.haveOne")}
          </Button>
        </div>
      </section>
    );
  }
  const submit = (event: FormEvent) => {
    event.preventDefault();
    onEnter(value);
  };
  return (
    <form className="flex max-w-prose flex-col gap-2" onSubmit={submit} data-sync-recovery-enter>
      <h3 className="text-base font-semibold">{t("sync.recovery.enterTitle")}</h3>
      <p className="text-sm text-muted">{t("sync.recovery.enterBody")}</p>
      <label htmlFor={id} className="text-sm font-medium">
        {t("sync.recovery.field")}
      </label>
      <Input
        id={id}
        className="font-mono"
        autoComplete="off"
        spellCheck={false}
        value={value}
        onChange={(event) => setValue(event.target.value)}
      />
      <div className="flex gap-2">
        <Button type="submit" variant="primary" disabled={busy || value.trim() === ""}>
          {t("sync.recovery.use")}
        </Button>
        <Button type="button" variant="ghost" onClick={onSwitch}>
          {t("sync.recovery.newInstead")}
        </Button>
      </div>
    </form>
  );
}

function ShowRecoveryKey({ value, onDone }: { value: string; onDone: () => void }) {
  const [saved, setSaved] = useState(false);
  const id = useId();
  return (
    <section className="flex max-w-prose flex-col gap-2" data-sync-recovery-show>
      <h3 className="text-base font-semibold">{t("sync.recovery.showTitle")}</h3>
      <p className="text-sm text-muted">{t("sync.recovery.showBody")}</p>
      <p
        className="rounded-md border border-border bg-surface-2 p-3 font-mono text-xl tracking-wider"
        data-recovery-key
      >
        {value}
      </p>
      <div className="flex items-center gap-2">
        <Switch id={id} checked={saved} onCheckedChange={setSaved} />
        <label htmlFor={id} className="text-sm">
          {t("sync.recovery.saved")}
        </label>
      </div>
      <div className="flex gap-2">
        <Button variant="ghost" onClick={() => void navigator.clipboard?.writeText(value)}>
          {t("sync.recovery.copy")}
        </Button>
        <Button variant="primary" disabled={!saved} onClick={onDone}>
          {t("sync.recovery.continue")}
        </Button>
      </div>
    </section>
  );
}
