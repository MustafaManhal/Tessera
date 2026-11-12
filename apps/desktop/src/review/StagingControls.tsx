import { useCallback, useEffect, useState } from "react";
import { Button, Dialog, DialogContent, DialogTitle, DialogDescription, DialogFooter, t } from "@tessera/ui";
import { stagingClient, type IndexFile, type Hunk } from "./stagingClient";
import { sendTaskPrompt } from "./useComments";
export function StagingControls({
  taskId,
  path,
  version,
  onRefresh,
}: {
  taskId: string;
  path: string | null;
  version: number;
  onRefresh: () => Promise<void>;
}) {
  const client = stagingClient();
  const [files, setFiles] = useState<IndexFile[]>([]),
    [hunks, setHunks] = useState<Hunk[]>([]),
    [staged, setStaged] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [message, setMessage] = useState(""),
    [result, setResult] = useState("");
  const [discard, setDiscard] = useState<{ path: string; hunk: Hunk | null } | null>(null);
  const fail = useCallback(
    (cause: unknown) =>
      setError(
        cause instanceof Error
          ? cause.message
          : typeof cause === "object" && cause && "message" in cause
            ? String(cause.message)
            : String(cause),
      ),
    [],
  );
  const load = useCallback(async () => {
    const [next, nextHunks] = await Promise.all([
      client.index(taskId),
      path ? client.hunks(taskId, path, staged) : Promise.resolve([]),
    ]);
    setFiles(next);
    setHunks(nextHunks);
  }, [client, taskId, path, staged]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: version invalidates index/hunks after an external refresh.
  useEffect(() => {
    let active = true;
    void Promise.all([client.index(taskId), path ? client.hunks(taskId, path, staged) : Promise.resolve([])])
      .then(([next, nextHunks]) => {
        if (active) {
          setFiles(next);
          setHunks(nextHunks);
        }
      })
      .catch((cause) => {
        if (active) fail(cause);
      });
    return () => {
      active = false;
    };
  }, [client, taskId, path, staged, version, fail]);
  const apply = async (mode: "stage" | "unstage" | "discard", hunk: Hunk | null, selected = path) => {
    if (!selected) return;
    setBusy(true);
    setError("");
    try {
      if (mode === "discard") await client.discard(taskId, selected, hunk, true);
      else await client[mode](taskId, selected, hunk);
      await load();
      await onRefresh();
    } catch (cause) {
      fail(cause);
    } finally {
      setBusy(false);
      setDiscard(null);
    }
  };
  const commit = async () => {
    setBusy(true);
    setError("");
    try {
      const commit = await client.commit(taskId, message);
      setResult(t("review.committed").replace("{hash}", commit.hash.slice(0, 7)));
      setMessage("");
      await load();
      await onRefresh();
    } catch (cause) {
      fail(cause);
    } finally {
      setBusy(false);
    }
  };
  const file = files.find((f) => f.path === path);
  const count = files.filter((f) => f.staged).length;
  return (
    <section
      aria-label={t("review.staging")}
      className="max-h-64 shrink-0 overflow-auto border-t border-border p-2 text-xs"
    >
      <div className="flex flex-wrap items-center gap-1">
        <span>{t("review.stagedCount").replace("{n}", String(count))}</span>
        <Button
          size="sm"
          variant="ghost"
          disabled={busy || !path || (!file?.unstaged && !file?.untracked)}
          onClick={() => void apply("stage", null)}
        >
          {t("review.stageFile")}
        </Button>
        <Button size="sm" variant="ghost" disabled={busy || !file?.staged} onClick={() => void apply("unstage", null)}>
          {t("review.unstageFile")}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={busy || !path || (!file?.unstaged && !file?.untracked)}
          onClick={() => {
            if (path) setDiscard({ path, hunk: null });
          }}
        >
          {t("review.discardFile")}
        </Button>
      </div>
      {error && (
        <pre role="alert" className="max-h-32 overflow-auto whitespace-pre-wrap text-st-error">
          {error}
        </pre>
      )}
      {result && <p role="status">{result}</p>}
      <details>
        <summary>{t("review.hunksCommit")}</summary>
        <div className="flex gap-1">
          <Button size="sm" variant="ghost" aria-pressed={!staged} disabled={busy} onClick={() => setStaged(false)}>
            {t("review.unstagedHunks")}
          </Button>
          <Button size="sm" variant="ghost" aria-pressed={staged} disabled={busy} onClick={() => setStaged(true)}>
            {t("review.stagedHunks")}
          </Button>
        </div>
        {hunks.length === 0 ? (
          <p className="py-1 text-muted">{t("review.noHunks")}</p>
        ) : (
          hunks.map((h) => (
            <div key={`${h.index}:${h.header}`} className="border-t border-border py-1" data-review-hunk>
              <pre className="max-h-24 overflow-auto whitespace-pre-wrap bg-surface-2 p-1 font-mono">{h.patch}</pre>
              <div className="flex gap-1">
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => void apply(staged ? "unstage" : "stage", h)}
                >
                  {staged ? t("review.unstageHunk") : t("review.stageHunk")}
                </Button>
                {!staged && path && (
                  <Button size="sm" variant="ghost" disabled={busy} onClick={() => setDiscard({ path, hunk: h })}>
                    {t("review.discardHunk")}
                  </Button>
                )}
              </div>
            </div>
          ))
        )}
        <form
          className="mt-2 flex flex-col gap-1"
          onSubmit={(e) => {
            e.preventDefault();
            void commit();
          }}
        >
          <label>
            {t("review.commitMessage")}
            <textarea
              className="w-full rounded-sm border border-border bg-bg p-1"
              rows={2}
              value={message}
              onChange={(e) => setMessage(e.target.value)}
            />
          </label>
          <div className="flex flex-wrap gap-1">
            <Button size="sm" type="submit" disabled={busy || !message.trim() || !count}>
              {t("review.commit")}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => {
                setError("");
                if (!sendTaskPrompt(taskId, t("review.askMessagePrompt"))) setError(t("review.noAgent"));
                else setResult(t("review.messageRequested"));
              }}
            >
              {t("review.askMessage")}
            </Button>
          </div>
        </form>
      </details>
      <Dialog
        open={discard !== null}
        onOpenChange={(open) => {
          if (!open && !busy) setDiscard(null);
        }}
      >
        <DialogContent role="alertdialog">
          <DialogTitle>{t("review.discardTitle")}</DialogTitle>
          <DialogDescription>{t("review.discardBody").replace("{path}", discard?.path ?? "")}</DialogDescription>
          <DialogFooter>
            <Button variant="ghost" disabled={busy} onClick={() => setDiscard(null)}>
              {t("button.cancel")}
            </Button>
            <Button
              variant="danger"
              disabled={busy}
              onClick={() => {
                if (discard) void apply("discard", discard.hunk, discard.path);
              }}
            >
              {t("review.confirmDiscard")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
