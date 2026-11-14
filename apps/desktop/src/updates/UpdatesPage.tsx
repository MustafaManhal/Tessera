// Settings, Updates (S-22, FR-73): channel, automatic checks, "Check now", the notes of an available version and
// "Install". After the install a restart finishes the update; it never restarts by itself.
import { Button, Icons, Select, Switch, t } from "@tessera/ui";
import { useEffect, useId, useState } from "react";
import { useAppDispatch } from "../store/hooks";
import { setWhatsNewOpen } from "../store/uiSlice";
import { updatesClient } from "./service";
import { setUpdateView, useUpdateView } from "./state";
import type { Channel, UpdateSettings } from "./types";

const message = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

function percent(downloaded: number, total: number | null): number | null {
  return total ? Math.min(100, Math.round((downloaded / total) * 100)) : null;
}

export function UpdatesPage() {
  const dispatch = useAppDispatch();
  const view = useUpdateView();
  const [settings, setSettings] = useState<UpdateSettings | null>(null);
  const [checking, setChecking] = useState(false);
  const [upToDate, setUpToDate] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const autoId = useId();

  useEffect(() => {
    void updatesClient()
      .settings()
      .then(setSettings)
      .catch((cause) => setError(message(cause)));
  }, []);

  const save = async (channel: Channel, auto: boolean) => {
    try {
      setSettings(await updatesClient().setSettings(channel, auto));
      if (channel !== settings?.channel) setUpdateView({ pending: null });
      setUpToDate(false);
    } catch (cause) {
      setError(message(cause));
    }
  };
  const check = async () => {
    setChecking(true);
    setError(null);
    setUpToDate(false);
    try {
      const found = await Promise.race([
        updatesClient().check(),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error(t("updates.timeout"))), 30_000)),
      ]);
      setUpdateView({ pending: found, installed: false });
      setUpToDate(found === null);
      setSettings(await updatesClient().settings());
    } catch (cause) {
      setError(message(cause));
    } finally {
      setChecking(false);
    }
  };
  const install = async () => {
    setError(null);
    setUpdateView({ installing: true, progress: null });
    try {
      await updatesClient().install();
      setUpdateView({ installing: false, installed: true, pending: null, progress: null });
    } catch (cause) {
      setUpdateView({ installing: false, progress: null });
      setError(message(cause));
    }
  };

  const pct = view.progress ? percent(view.progress.downloaded, view.progress.total) : null;
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-6 pb-6 pt-2" data-updates-page>
      <p className="m-0 max-w-prose text-sm text-muted">{t("updates.explain")}</p>
      <section className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-surface-2 px-4 py-3">
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="text-xs text-muted" data-update-last>
            {settings?.last_checked
              ? t("updates.lastChecked", { when: new Date(settings.last_checked * 1000).toLocaleString() })
              : t("updates.neverChecked")}
          </span>
          <Button size="sm" variant="ghost" className="self-start px-0" onClick={() => dispatch(setWhatsNewOpen(true))}>
            {t("updates.whatsNew")}
          </Button>
        </div>
        <Button
          size="sm"
          variant="secondary"
          icon={Icons.RefreshCw}
          disabled={checking || view.installing}
          onClick={() => void check()}
        >
          {checking ? t("updates.checking") : t("updates.checkNow")}
        </Button>
      </section>
      <section className="flex flex-col gap-3 rounded-lg border border-border px-4 py-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-base">{t("updates.channel")}</span>
          <Select
            aria-label={t("updates.channel")}
            value={settings?.channel ?? "stable"}
            onValueChange={(value) => void save(value as Channel, settings?.auto_check ?? true)}
            options={[
              { value: "stable", label: t("updates.channel.stable") },
              { value: "beta", label: t("updates.channel.beta") },
            ]}
            className="w-56"
          />
        </div>
        <div className="flex items-center justify-between gap-3">
          <label htmlFor={autoId} className="text-base">
            {t("updates.auto")}
          </label>
          <Switch
            id={autoId}
            checked={settings?.auto_check ?? true}
            onCheckedChange={(checked) => void save(settings?.channel ?? "stable", checked)}
          />
        </div>
      </section>
      {error && (
        <p
          role="alert"
          data-update-error
          className="rounded-md border border-border bg-st-error-tint px-3 py-2 text-sm"
        >
          {error}
        </p>
      )}
      {upToDate && !view.pending && (
        <p role="status" data-update-uptodate className="text-sm">
          {t("updates.upToDate")}
        </p>
      )}
      {view.installed && (
        <div className="flex flex-col gap-2 rounded-md border border-border bg-surface-2 p-3" data-update-installed>
          <p className="m-0 text-sm">{t("updates.installed")}</p>
          <div>
            <Button size="sm" variant="primary" onClick={() => void updatesClient().relaunch()}>
              {t("updates.restart")}
            </Button>
          </div>
        </div>
      )}
      {view.pending && !view.installed && (
        <div className="flex flex-col gap-2 rounded-md border border-border bg-surface-2 p-3" data-update-available>
          <div className="flex flex-wrap items-baseline gap-2">
            <span className="text-sm font-medium">{t("updates.available", { version: view.pending.version })}</span>
            <span className="text-xs text-muted">
              {t("updates.current", { version: view.pending.current_version })}
            </span>
          </div>
          {view.pending.notes ? (
            <pre
              className="m-0 max-h-56 overflow-auto whitespace-pre-wrap rounded-sm bg-surface p-2 font-sans text-sm"
              data-update-notes
            >
              {view.pending.notes}
            </pre>
          ) : (
            <p className="m-0 text-sm text-muted">{t("updates.noNotes")}</p>
          )}
          {view.installing && (
            <div data-update-progress>
              <progress className="w-full" max={100} value={pct ?? undefined} aria-label={t("updates.downloading")} />
              <span className="text-xs text-muted">{pct === null ? t("updates.downloading") : `${pct}%`}</span>
            </div>
          )}
          <div>
            <Button size="sm" variant="primary" disabled={view.installing} onClick={() => void install()}>
              {view.installing ? t("updates.installing") : t("updates.install")}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
