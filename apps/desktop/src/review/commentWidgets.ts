import { Decoration, EditorView, WidgetType } from "@codemirror/view";
import type { EditorState } from "@codemirror/state";
import { t } from "@tessera/ui";
import type { ReviewComment } from "./commentsClient";
export interface CommentActions {
  edit: (row: ReviewComment) => void;
  remove: (row: ReviewComment) => void;
  resolve: (row: ReviewComment) => void;
}
class CommentWidget extends WidgetType {
  constructor(
    private row: ReviewComment,
    private actions: CommentActions,
  ) {
    super();
  }
  toDOM() {
    const row = this.row;
    const root = document.createElement("div");
    root.className = "m-1 rounded-sm border border-border bg-surface-2 p-2 text-xs text-fg";
    root.style.width = "calc(100cqw - 3rem)";
    root.style.maxWidth = "100%";
    root.style.whiteSpace = "normal";
    root.dataset.reviewComment = row.id;
    const location = document.createElement("p");
    location.className = "text-muted";
    location.textContent = `${row.side} ${row.line_start}-${row.line_end} · ${row.sent_at === null ? t("review.commentUnsent") : t("review.commentSent")}${row.resolved ? ` · ${t("review.commentResolved")}` : ""}`;
    root.append(location);
    const body = document.createElement("p");
    body.className = "whitespace-pre-wrap";
    body.textContent = row.body;
    root.append(body);
    const controls = document.createElement("div");
    controls.className = "mt-1 flex flex-wrap gap-2";
    for (const [label, action] of [
      [t("review.editComment"), () => this.actions.edit(row)],
      [row.resolved ? t("review.reopenComment") : t("review.resolveComment"), () => this.actions.resolve(row)],
      [t("review.deleteComment"), () => this.actions.remove(row)],
    ] as const) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "rounded-sm px-1 text-accent-ink";
      button.textContent = label;
      button.addEventListener("click", action);
      controls.append(button);
    }
    root.append(controls);
    return root;
  }
  override ignoreEvent() {
    return true;
  }
}
export function commentWidgets(
  doc: EditorState["doc"],
  rows: ReviewComment[],
  side: "base" | "head",
  actions: CommentActions,
) {
  return EditorView.decorations.of(
    Decoration.set(
      rows
        .filter((c) => c.side === side)
        .map((c) =>
          Decoration.widget({ widget: new CommentWidget(c, actions), block: true, side: 1 }).range(
            doc.line(Math.min(doc.lines, Math.max(1, c.line_end))).to,
          ),
        ),
      true,
    ),
  );
}
