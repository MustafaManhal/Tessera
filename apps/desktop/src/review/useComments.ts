import { useCallback, useEffect, useState } from "react";
import { t } from "@tessera/ui";
import { store } from "../store";
import { sendPromptToAgents } from "../prompts/send";
import { commentsClient, type CommentInput, type ReviewComment } from "./commentsClient";
export type CommentSelection = Pick<CommentInput, "file_path" | "side" | "line_start" | "line_end" | "code_excerpt">;
export type CommentDraft = CommentSelection & { id?: string; body: string };
export function sendTaskPrompt(taskId: string, text: string): boolean {
  const state = store.getState();
  const sessions = Object.values(state.agentSessions.sessions)
    .filter((s) => s.task_id === taskId && s.status !== "exited" && s.pane_id && state.layout.panes[s.pane_id])
    .sort((a, b) => b.started_at - a.started_at);
  for (const session of sessions)
    if (session.pane_id && sendPromptToAgents(text, [{ sessionId: session.id, paneId: session.pane_id }]).length > 0)
      return true;
  return false;
}
export function useComments(taskId: string) {
  const client = commentsClient();
  const [rows, setRows] = useState<ReviewComment[]>([]),
    [draft, setDraft] = useState<CommentDraft | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const report = useCallback(
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
  useEffect(() => {
    let active = true;
    void client
      .list(taskId)
      .then((rows) => {
        if (active) setRows(rows);
      })
      .catch(report);
    return () => {
      active = false;
    };
  }, [client, taskId, report]);
  const select = useCallback((selection: CommentSelection) => {
    setError("");
    setDraft((old) => ({ ...selection, body: old && !old.id ? old.body : "" }));
  }, []);
  const edit = useCallback((row: ReviewComment) => {
    setError("");
    setDraft({ ...row });
  }, []);
  const remove = useCallback(
    async (row: ReviewComment) => {
      try {
        await client.remove(row.id);
        setRows(await client.list(taskId));
        setDraft((old) => (old?.id === row.id ? null : old));
      } catch (cause) {
        report(cause);
      }
    },
    [client, taskId, report],
  );
  const resolve = useCallback(
    async (row: ReviewComment) => {
      try {
        await client.update(row.id, row.body, !row.resolved);
        setRows(await client.list(taskId));
      } catch (cause) {
        report(cause);
      }
    },
    [client, taskId, report],
  );
  const save = async () => {
    if (!draft || !draft.body.trim()) return;
    setBusy(true);
    setError("");
    try {
      if (draft.id) await client.update(draft.id, draft.body, rows.find((c) => c.id === draft.id)?.resolved ?? false);
      else await client.add({ task_id: taskId, ...draft });
      setRows(await client.list(taskId));
      setDraft(null);
    } catch (cause) {
      report(cause);
    } finally {
      setBusy(false);
    }
  };
  const send = async () => {
    setBusy(true);
    setError("");
    try {
      const batch = await client.prepare(taskId);
      if (!batch.comments.length) return;
      if (!sendTaskPrompt(taskId, batch.text)) {
        setError(t("review.noAgent"));
        return;
      }
      setRows(
        await client.sent(
          taskId,
          batch.comments.map(({ id, body }) => ({ id, body })),
        ),
      );
    } catch (cause) {
      report(cause);
    } finally {
      setBusy(false);
    }
  };
  return { rows, draft, setDraft, error, busy, select, edit, remove, resolve, save, send };
}
export type CommentsModel = ReturnType<typeof useComments>;
