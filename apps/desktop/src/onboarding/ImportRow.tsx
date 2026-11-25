// Settings row: import fonts and other settings from Ghostty, iTerm2 or Windows Terminal (FR-69). It used to be a
// step of the first-run wizard; the wizard now only explains the app, so the importers live here. Each available
// source gets a button; the preview lists what will be applied and what cannot be, before anything changes.
import { Button, Dialog, DialogContent, DialogFooter, DialogTitle, Icons, t } from "@tessera/ui";
import { useEffect, useState } from "react";
import { onboarding } from "./client";
import type { ImportPreview, ImportSource } from "./types";

function errorMessage(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  if (typeof cause === "object" && cause && "message" in cause) return String(cause.message);
  return String(cause);
}

export function ImportRow() {
  const [sources, setSources] = useState<ImportSource[] | null>(null);
  const [preview, setPreview] = useState<{ source: ImportSource; data: ImportPreview } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void onboarding()
      .importSources()
      .then((list) => alive && setSources(list.filter((source) => source.available)))
      .catch(() => alive && setSources([]));
    return () => {
      alive = false;
    };
  }, []);

  // Nothing to import from on this computer: no row.
  if (!sources || sources.length === 0) return null;

  const show = async (source: ImportSource) => {
    setBusy(`import:${source.id}`);
    setError(null);
    setDone(null);
    try {
      setPreview({ source, data: await onboarding().importPreview(source.id) });
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(null);
    }
  };

  const confirm = async () => {
    if (!preview) return;
    setBusy("apply");
    setError(null);
    try {
      await onboarding().importApply(preview.source.id);
      setDone(t("onboarding.imported", { name: preview.source.name }));
      setPreview(null);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div data-setting="import.terminal" className="flex flex-col gap-2 border-b border-border py-4">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex min-w-0 flex-col gap-0.5">
          <p className="text-base font-medium">{t("onboarding.importTitle")}</p>
          <p className="text-sm text-muted">{t("onboarding.importLine")}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          {sources.map((source) => (
            <Button
              key={source.id}
              size="sm"
              variant="secondary"
              onClick={() => void show(source)}
              loading={busy === `import:${source.id}`}
            >
              {t("onboarding.importFrom", { name: source.name })}
            </Button>
          ))}
        </div>
      </div>
      {done && (
        <p role="status" className="m-0 text-sm text-muted">
          {done}
        </p>
      )}
      {error && (
        <p role="alert" className="m-0 rounded-md border border-border bg-st-error-tint px-2 py-1 text-xs">
          {error}
        </p>
      )}
      <Dialog open={preview !== null} onOpenChange={(open) => !open && setPreview(null)}>
        <DialogContent>
          <DialogTitle>{t("onboarding.importPreview", { name: preview?.source.name ?? "" })}</DialogTitle>
          {preview && (
            <div className="space-y-2 text-sm">
              {preview.data.applied.length > 0 && (
                <ul className="space-y-1" data-import-applied>
                  {preview.data.applied.map((item) => (
                    <li key={item.key} className="flex items-center gap-2">
                      <Icons.Check className="size-3.5 text-st-done" aria-hidden />
                      {item.label}
                    </li>
                  ))}
                </ul>
              )}
              {preview.data.failed.length > 0 && (
                <div>
                  <p className="text-xs font-medium text-muted">{t("onboarding.couldNotImport")}</p>
                  <ul className="mt-1 space-y-1" data-import-failed>
                    {preview.data.failed.map((miss) => (
                      <li key={miss.item} className="text-xs text-muted">
                        {miss.item}: {miss.reason}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
          <DialogFooter>
            <Button variant="ghost" onClick={() => setPreview(null)}>
              {t("onboarding.cancel")}
            </Button>
            <Button
              onClick={() => void confirm()}
              loading={busy === "apply"}
              disabled={!preview || preview.data.applied.length === 0}
            >
              {t("onboarding.importConfirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
