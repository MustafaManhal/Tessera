// The "Pull request" surface inside the review panel (M7.5): create form when the task has no PR,
// otherwise PR state, the S-09 checks list, merge actions and the archive prompt.

import { useCallback, useEffect, useMemo, useState } from "react";
import { Button, Dialog, DialogContent, DialogFooter, DialogTitle, Icons, Input, t } from "@tessera/ui";
import { useAppSelector } from "../store/hooks";
import { projectsClient } from "../projects/service";
import { sendPromptToAgents } from "../prompts/send";
import { pulls } from "./client";
import type { CheckItem, MergeMethod, PrInfo } from "./types";

function errorMessage(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  if (typeof cause === "object" && cause && "message" in cause) return String(cause.message);
  return String(cause);
}

function duration(ms: number | null): string {
  if (ms === null) return "";
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}

function checkState(item: CheckItem): "pending" | "success" | "failure" {
  if (item.status !== "completed") return "pending";
  return item.conclusion === "success" || item.conclusion === "neutral" || item.conclusion === "skipped"
    ? "success"
    : "failure";
}

export function PrPanel({ taskId }: { taskId: string }) {
  const task = useAppSelector((state) => Object.values(state.projects.tasks).find((t) => t.id === taskId));
  const sessions = useAppSelector((state) => state.agentSessions.sessions);
  const [pr, setPr] = useState<PrInfo | null>(null);
  const [checks, setChecks] = useState<CheckItem[]>([]);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [draft, setDraft] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [archiveAsk, setArchiveAsk] = useState(false);
  const [conflicts, setConflicts] = useState<string[] | null>(null);
  const [method, setMethod] = useState<MergeMethod>("merge");

  const hasPr = Boolean(task?.pr_number);

  const refresh = useCallback(async () => {
    setBusy("refresh");
    setError(null);
    try {
      const info = await pulls().prRefresh(taskId);
      setPr(info);
      setChecks(
        await pulls()
          .prChecks(taskId)
          .catch(() => []),
      );
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(null);
    }
  }, [taskId]);

  useEffect(() => {
    if (hasPr) {
      void refresh();
      return;
    }
    setTitle(task?.name ?? "");
    setBody(task?.prompt ?? "");
  }, [hasPr, refresh, task?.name, task?.prompt]);

  // Refresh every minute while the panel shows a pull request and the window is visible (ETag keeps it cheap).
  useEffect(() => {
    if (!hasPr) return;
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, 60_000);
    return () => clearInterval(timer);
  }, [hasPr, refresh]);

  const agentTargets = useMemo(
    () =>
      Object.values(sessions)
        .filter((s) => s.task_id === taskId && s.pane_id)
        .map((s) => ({ sessionId: s.id, paneId: s.pane_id as string })),
    [sessions, taskId],
  );

  const create = async () => {
    setBusy("create");
    setError(null);
    try {
      const info = await pulls().prCreate(taskId, title.trim() || task?.name || "", body, draft);
      setPr(info);
      setChecks(
        await pulls()
          .prChecks(taskId)
          .catch(() => []),
      );
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(null);
    }
  };

  const sendFailure = async () => {
    setBusy("failure");
    setError(null);
    setNotice(null);
    try {
      const log = await pulls().prFailureLog(taskId);
      const delivered = sendPromptToAgents(
        `The CI checks for this pull request failed. Last lines of the failing job:\n\n\`\`\`\n${log}\n\`\`\`\n\nPlease fix the failure.`,
        agentTargets,
      );
      setNotice(delivered.length ? t("pulls.sent") : t("pulls.noAgent"));
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(null);
    }
  };

  const merge = async (method: MergeMethod) => {
    setBusy(`merge:${method}`);
    setError(null);
    try {
      const info = await pulls().prMerge(taskId, method);
      setPr(info);
      setArchiveAsk(true);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(null);
    }
  };

  const mergeLocal = async () => {
    setBusy("merge:local");
    setError(null);
    setConflicts(null);
    try {
      const result = await pulls().prMergeLocal(taskId);
      if (result.merged) setArchiveAsk(true);
      else setConflicts(result.conflicts);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(null);
    }
  };

  const archive = async () => {
    setArchiveAsk(false);
    setBusy("archive");
    try {
      await projectsClient().taskArchive(taskId);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(null);
    }
  };

  const failing = checks.some((c) => checkState(c) === "failure");
  const mergeable = pr?.merged !== true && pr?.state === "open" && pr?.mergeable !== false && !failing;

  return (
    <div className="space-y-2 p-2 text-sm" data-pr-panel>
      {!hasPr && !pr ? (
        <div className="space-y-2">
          <p className="text-xs text-muted">{t("pulls.create")}</p>
          <Input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder={t("pulls.title")}
            aria-label={t("pulls.title")}
          />
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder={t("pulls.body")}
            aria-label={t("pulls.body")}
            rows={6}
            className="w-full rounded-md border border-border bg-surface px-2 py-1 text-sm"
          />
          <label className="flex items-center gap-2 text-xs">
            <input type="checkbox" checked={draft} onChange={(e) => setDraft(e.target.checked)} />
            {t("pulls.draft")}
          </label>
          {error && (
            <p role="alert" className="rounded-md border border-border bg-st-error-tint px-2 py-1 text-xs">
              {error}
            </p>
          )}
          <div className="flex gap-2">
            <Button
              size="sm"
              onClick={() => void create()}
              loading={busy === "create"}
              disabled={!title.trim() && !task?.name}
            >
              {busy === "create" ? t("pulls.pushing") : t("pulls.createSubmit")}
            </Button>
          </div>
        </div>
      ) : (
        <>
          <div className="flex items-center gap-2">
            <span className="font-medium">#{pr?.number}</span>
            <span className="text-xs text-muted">{t(`pulls.state.${pr?.state ?? "open"}` as never)}</span>
            {pr?.ci_state && <span className="text-xs text-muted">{t(`pulls.ci.${pr.ci_state}` as never)}</span>}
            {pr?.url && (
              <a
                href={pr.url}
                target="_blank"
                rel="noreferrer"
                className="ml-auto text-xs text-accent-ink hover:underline"
              >
                {t("pulls.view")}
              </a>
            )}
          </div>
          {checks.length > 0 && (
            <ul className="space-y-1" data-checks-list>
              {checks.map((check) => {
                const state = checkState(check);
                return (
                  <li key={check.name} className="flex items-center gap-2 text-xs">
                    <span
                      className={
                        state === "success" ? "text-st-done" : state === "failure" ? "text-st-error" : "text-st-working"
                      }
                      aria-hidden
                    >
                      {state === "success" ? "✓" : state === "failure" ? "✗" : "…"}
                    </span>
                    <span className="min-w-0 flex-1 truncate" title={check.name}>
                      {check.name}
                    </span>
                    <span className="text-muted">{duration(check.duration_ms)}</span>
                    {check.url && (
                      <a href={check.url} target="_blank" rel="noreferrer" className="text-accent-ink hover:underline">
                        ↗
                      </a>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
          {checks.length === 0 && <p className="text-xs text-muted">{t("pulls.noChecks")}</p>}
          {conflicts && (
            <div className="rounded-md border border-border bg-st-error-tint px-2 py-1 text-xs" data-merge-conflicts>
              <p className="font-medium">{t("pulls.conflicts")}</p>
              <ul className="mt-1 list-inside list-disc">
                {conflicts.map((path) => (
                  <li key={path}>{path}</li>
                ))}
              </ul>
            </div>
          )}
          {error && (
            <p role="alert" className="rounded-md border border-border bg-st-error-tint px-2 py-1 text-xs">
              {error}
            </p>
          )}
          {notice && <p className="text-xs text-st-done">{notice}</p>}
          <div className="flex flex-wrap items-center gap-2">
            {failing && agentTargets.length > 0 && (
              <Button size="sm" variant="ghost" onClick={() => void sendFailure()} loading={busy === "failure"}>
                {t("pulls.sendFailure")}
              </Button>
            )}
            <select
              aria-label={t("pulls.mergeMethod")}
              className="rounded-md border border-border bg-surface px-1 py-1 text-xs"
              value={method}
              onChange={(e) => setMethod(e.target.value as MergeMethod)}
              data-merge-method
            >
              <option value="merge">{t("pulls.mergeCommit")}</option>
              <option value="squash">{t("pulls.squash")}</option>
              <option value="rebase">{t("pulls.rebase")}</option>
            </select>
            <Button
              size="sm"
              disabled={!mergeable}
              title={mergeable ? undefined : t("pulls.mergeBlocked")}
              onClick={() => void merge(method)}
            >
              {t("pulls.merge")}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => void mergeLocal()} loading={busy === "merge:local"}>
              {t("pulls.mergeLocal")}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => void refresh()} loading={busy === "refresh"}>
              <Icons.RotateCw className="size-3.5" />
            </Button>
          </div>
        </>
      )}

      <Dialog open={archiveAsk} onOpenChange={setArchiveAsk}>
        <DialogContent>
          <DialogTitle>{t("pulls.archiveAsk")}</DialogTitle>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setArchiveAsk(false)}>
              {t("pulls.archiveNo")}
            </Button>
            <Button onClick={() => void archive()} loading={busy === "archive"}>
              {t("pulls.archiveYes")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
