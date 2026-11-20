import { useEffect, useRef } from "react";
import { Button, t } from "@tessera/ui";
import type { CommentsModel, CommentSelection } from "./useComments";
export function Comments({ model, selection }: { model: CommentsModel; selection: CommentSelection | null }) {
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const draftKey = model.draft
    ? `${model.draft.id ?? "new"}:${model.draft.file_path}:${model.draft.side}:${model.draft.line_start}-${model.draft.line_end}`
    : "";
  useEffect(() => {
    if (draftKey) inputRef.current?.focus();
  }, [draftKey]);
  const count = model.rows.filter((c) => c.sent_at === null && !c.resolved).length;
  return (
    <section
      aria-label={t("review.comments")}
      className="max-h-64 shrink-0 overflow-auto border-t border-border p-2 text-xs"
    >
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant="ghost"
          disabled={!selection}
          onClick={() => {
            if (selection) model.select(selection);
          }}
        >
          {t("review.addComment")}
        </Button>
        <Button size="sm" disabled={!count || model.busy} onClick={() => void model.send()}>
          {t("review.sendComments").replace("{n}", String(count))}
        </Button>
      </div>
      {model.error && (
        <p role="alert" className="py-1 text-st-error">
          {model.error}
        </p>
      )}
      {model.draft && (
        <form
          className="mt-2 flex flex-col gap-1"
          onSubmit={(e) => {
            e.preventDefault();
            void model.save();
          }}
        >
          <p>
            {model.draft.file_path}:{model.draft.line_start}-{model.draft.line_end} · {model.draft.side}
          </p>
          <pre className="max-h-16 overflow-auto whitespace-pre-wrap bg-surface-2 p-1 font-mono">
            {model.draft.code_excerpt}
          </pre>
          <label>
            {t("review.commentBody")}
            <textarea
              ref={inputRef}
              className="mt-1 w-full rounded-sm border border-border bg-bg p-1 text-fg"
              rows={2}
              value={model.draft.body}
              onChange={(e) => model.setDraft((old) => (old ? { ...old, body: e.target.value } : null))}
            />
          </label>
          <div className="flex gap-1">
            <Button type="submit" size="sm" disabled={!model.draft.body.trim() || model.busy}>
              {t("review.saveComment")}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => model.setDraft(null)}>
              {t("button.cancel")}
            </Button>
          </div>
        </form>
      )}
      {model.rows.length > 0 && (
        <details className="mt-1">
          <summary>
            {t("review.comments")} ({model.rows.length})
          </summary>
          {model.rows.map((c) => (
            <div key={c.id} className="border-t border-border py-1">
              <p>
                {c.file_path}:{c.line_start}-{c.line_end} · {c.side} {c.sent_at !== null ? t("review.commentSent") : ""}{" "}
                {c.resolved ? t("review.commentResolved") : ""}
              </p>
              <p className="whitespace-pre-wrap">{c.body}</p>
              <div className="flex gap-1">
                <Button size="sm" variant="ghost" onClick={() => model.edit(c)}>
                  {t("review.editComment")}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => void model.resolve(c)}>
                  {c.resolved ? t("review.reopenComment") : t("review.resolveComment")}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => void model.remove(c)}>
                  {t("review.deleteComment")}
                </Button>
              </div>
            </div>
          ))}
        </details>
      )}
    </section>
  );
}
