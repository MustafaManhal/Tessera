import { useEffect, useRef, useState } from "react";
import { HighlightStyle, defaultHighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { EditorState, type Extension } from "@codemirror/state";
import { EditorView, lineNumbers } from "@codemirror/view";
import { MergeView, unifiedMergeView, diff, Change } from "@codemirror/merge";
import { t } from "@tessera/ui";
import type { ReviewComment } from "./commentsClient";
import type { CommentSelection } from "./useComments";
import { commentWidgets, type CommentActions } from "./commentWidgets";
async function language(path: string): Promise<Extension> {
  const ext = path.split(".").at(-1)?.toLowerCase();
  switch (ext) {
    case "ts":
    case "tsx":
    case "js":
    case "jsx":
      return (await import("@codemirror/lang-javascript")).javascript({
        typescript: ext.startsWith("ts"),
        jsx: ext.endsWith("x"),
      });
    case "json":
      return (await import("@codemirror/lang-json")).json();
    case "html":
      return (await import("@codemirror/lang-html")).html();
    case "css":
      return (await import("@codemirror/lang-css")).css();
    case "py":
      return (await import("@codemirror/lang-python")).python();
    case "rs":
      return (await import("@codemirror/lang-rust")).rust();
    case "md":
      return (await import("@codemirror/lang-markdown")).markdown();
    case "sql":
      return (await import("@codemirror/lang-sql")).sql();
    default:
      return [];
  }
}
function strip(text: string) {
  let value = "";
  const positions: number[] = [];
  for (let i = 0; i < text.length; i++)
    if (text[i] !== " " && text[i] !== "\t") {
      positions.push(i);
      value += text[i];
    }
  positions.push(text.length);
  return { value, positions };
}
export function whitespaceDiff(a: string, b: string): readonly Change[] {
  const left = strip(a),
    right = strip(b);
  return diff(left.value, right.value, { scanLimit: 500, timeout: 100 }).map(
    (c) =>
      new Change(
        left.positions[c.fromA] ?? a.length,
        left.positions[c.toA] ?? a.length,
        right.positions[c.fromB] ?? b.length,
        right.positions[c.toB] ?? b.length,
      ),
  );
}
// Preserve CodeMirror's standard semantic token groups, replacing its fixed colors with theme tokens.
const syntaxPalette = ["var(--accent)", "var(--st-working)", "var(--st-needs)", "var(--st-done)", "var(--muted)"];
const tokenHighlight = syntaxHighlighting(
  HighlightStyle.define(
    defaultHighlightStyle.specs.map((style, index) => ({
      ...style,
      ...(style.color ? { color: syntaxPalette[index % syntaxPalette.length] } : {}),
    })),
  ),
);
const theme = EditorView.theme({
  "&": {
    height: "100%",
    backgroundColor: "var(--surface)",
    color: "var(--fg)",
    fontSize: "var(--font-size-sm)",
    containerType: "inline-size",
  },
  ".cm-scroller": { overflow: "auto", fontFamily: "var(--font-mono)" },
  ".cm-gutters": { backgroundColor: "var(--surface-2)", color: "var(--muted)", borderColor: "var(--border)" },
  ".cm-content": { caretColor: "transparent" },
  "&.cm-merge-a .cm-changedLine, .cm-deletedChunk": { backgroundColor: "var(--st-error-tint)" },
  "&.cm-merge-b .cm-changedLine, .cm-inlineChangedLine": { backgroundColor: "var(--st-done-tint)" },
  "&.cm-merge-a .cm-changedText, & .cm-deletedChunk .cm-deletedText, &.cm-merge-b .cm-deletedText": {
    background: "var(--st-error-tint) !important",
    color: "var(--fg)",
  },
  "&.cm-merge-b .cm-changedText": { background: "var(--st-done-tint) !important" },
  "&.cm-merge-a .cm-changedLineGutter, & .cm-deletedLineGutter": { background: "var(--st-error) !important" },
  "&.cm-merge-b .cm-changedLineGutter, & .cm-inlineChangedLineGutter": { background: "var(--st-done) !important" },
  ".cm-deletedChunk": { borderColor: "var(--border)" },
});
export function DiffView({
  path,
  base,
  head,
  unified,
  ignoreWhitespace,
  comments = [],
  onComment,
  commentActions,
}: {
  path: string;
  base: string;
  head: string;
  unified: boolean;
  ignoreWhitespace: boolean;
  comments?: ReviewComment[];
  onComment?: (selection: CommentSelection) => void;
  commentActions?: CommentActions;
}) {
  const root = useRef<HTMLElement>(null);
  const [error, setError] = useState("");
  const anchor = useRef<{ path: string; side: "base" | "head"; line: number } | null>(null);
  const scroll = useRef(0);
  useEffect(() => {
    let stopped = false;
    let view: MergeView | EditorView | undefined;
    setError("");
    void language(path)
      .then((lang) => {
        if (stopped || !root.current) return;
        const extensions = [
          EditorState.readOnly.of(true),
          EditorView.editable.of(false),
          lineNumbers({
            domEventHandlers: {
              mousedown: (editor, block, event) => {
                if (!onComment) return false;
                const side: "base" | "head" = !unified && editor.dom.classList.contains("cm-merge-a") ? "base" : "head";
                const line = editor.state.doc.lineAt(block.from).number;
                const from =
                  (event as MouseEvent).shiftKey && anchor.current?.path === path && anchor.current.side === side
                    ? Math.min(editor.state.doc.lines, anchor.current.line)
                    : line;
                anchor.current = { path, side, line: from };
                const start = Math.min(from, line),
                  end = Math.max(from, line);
                onComment({
                  file_path: path,
                  side,
                  line_start: start,
                  line_end: end,
                  code_excerpt: editor.state.doc.sliceString(
                    editor.state.doc.line(start).from,
                    editor.state.doc.line(end).to,
                  ),
                });
                return true;
              },
            },
          }),
          lang,
          tokenHighlight,
          theme,
        ];
        const diffConfig = ignoreWhitespace ? { override: whitespaceDiff } : { timeout: 100, scanLimit: 500 };
        const aDoc = EditorState.create({ doc: base }).doc;
        const bDoc = EditorState.create({ doc: head }).doc;
        const aComments = commentActions ? commentWidgets(aDoc, comments, "base", commentActions) : [];
        const bComments = commentActions ? commentWidgets(bDoc, comments, "head", commentActions) : [];
        view = unified
          ? new EditorView({
              parent: root.current,
              doc: head,
              extensions: [
                ...extensions,
                bComments,
                unifiedMergeView({ original: base, diffConfig, mergeControls: false }),
              ],
            })
          : new MergeView({
              parent: root.current,
              a: { doc: base, extensions: [...extensions, aComments] },
              b: { doc: head, extensions: [...extensions, bComments] },
              diffConfig,
            });
        if (view instanceof MergeView) view.dom.scrollTop = scroll.current;
        else view.scrollDOM.scrollTop = scroll.current;
      })
      .catch((cause) => {
        if (!stopped) setError(String(cause));
      });
    return () => {
      stopped = true;
      if (view) scroll.current = view instanceof MergeView ? view.dom.scrollTop : view.scrollDOM.scrollTop;
      view?.destroy();
    };
  }, [path, base, head, unified, ignoreWhitespace, comments, onComment, commentActions]);
  return (
    <div
      className="min-h-0 flex-1 overflow-auto"
      data-review-diff
      data-mode={unified ? "unified" : "split"}
      data-ignore-whitespace={ignoreWhitespace}
    >
      <section
        ref={root}
        className="h-full [&_.cm-mergeView]:h-full [&_.cm-mergeView]:overflow-auto"
        aria-label={t("review.diff")}
      />
      {error && <p role="alert">{error}</p>}
    </div>
  );
}
