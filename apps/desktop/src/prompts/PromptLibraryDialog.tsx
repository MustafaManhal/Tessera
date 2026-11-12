// The S-23 prompt library: searchable list with use counts, an editor (name, body, tags) with live variable
// detection and a preview filling {{task}}/{{branch}}/{{issue}}, "Use in new task", "Use in prompt bar", delete
// with confirmation.
import { Button, Dialog, DialogContent, DialogFooter, DialogTitle, Input, t } from "@tessera/ui";
import { useCallback, useEffect, useState } from "react";
import { useAppDispatch, useAppSelector } from "../store/hooks";
import { openPromptBar, setProjectDialog, setPromptLibraryOpen } from "../store/uiSlice";
import { prompts, type PromptEntry, type PromptInput } from "./client";
import { detectVariables, expandVariables, type VariableValues } from "./variables";

export function PromptLibraryDialog() {
  const dispatch = useAppDispatch();
  const open = useAppSelector((state) => state.ui.promptLibraryOpen);
  const tasks = useAppSelector((state) => state.projects.tasks);
  const [query, setQuery] = useState("");
  const [entries, setEntries] = useState<PromptEntry[]>([]);
  const [editing, setEditing] = useState<PromptInput | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<PromptEntry | null>(null);

  const refresh = useCallback(async () => {
    setEntries(
      await prompts()
        .list(query || undefined)
        .catch(() => []),
    );
  }, [query]);

  useEffect(() => {
    if (open) void refresh();
  }, [open, refresh]);

  const close = () => {
    dispatch(setPromptLibraryOpen(false));
    setEditing(null);
    setConfirmDelete(null);
    setQuery("");
  };

  const save = async () => {
    if (!editing?.name.trim() || !editing.body.trim()) return;
    await prompts()
      .save(editing)
      .catch(() => {});
    setEditing(null);
    await refresh();
  };

  const remove = async () => {
    if (!confirmDelete) return;
    await prompts()
      .remove(confirmDelete.id)
      .catch(() => {});
    setConfirmDelete(null);
    await refresh();
  };

  const sendToNewTask = (entry: PromptEntry) => {
    // Opens New task with the body as the prompt (any project: the dialog lets the user pick).
    dispatch(setProjectDialog({ kind: "newTask", projectId: null, prompt: entry.body }));
    close();
  };

  const sendToPromptBar = (entry: PromptEntry) => {
    dispatch(openPromptBar({ text: entry.body }));
    void prompts()
      .used(entry.id)
      .catch(() => {});
    close();
  };

  const previewValues: VariableValues = (() => {
    const first = Object.values(tasks)[0];
    return { task: first?.name ?? null, branch: first?.branch ?? null, issue: null };
  })();

  return (
    <Dialog open={open} onOpenChange={(next) => !next && close()}>
      <DialogContent className="flex max-h-[80vh] w-[42rem] max-w-[calc(100vw-2rem)] flex-col" data-prompt-library>
        <DialogTitle>{t("library.title")}</DialogTitle>
        {editing ? (
          <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto">
            <label className="flex flex-col gap-1 text-xs text-muted" htmlFor="prompt-name">
              {t("library.name")}
            </label>
            <Input
              id="prompt-name"
              value={editing.name}
              onChange={(e) => setEditing({ ...editing, name: e.target.value })}
            />
            <label className="flex flex-col gap-1 text-xs text-muted" htmlFor="prompt-body">
              {t("library.body")}
            </label>
            <textarea
              id="prompt-body"
              value={editing.body}
              onChange={(e) => setEditing({ ...editing, body: e.target.value })}
              rows={8}
              className="w-full resize-y rounded-md border border-border bg-term-bg px-2 py-1.5 font-mono text-sm text-fg outline-none focus:border-accent"
            />
            <label className="flex flex-col gap-1 text-xs text-muted" htmlFor="prompt-tags">
              {t("library.tags")}
            </label>
            <Input
              id="prompt-tags"
              value={editing.tags?.join(", ") ?? ""}
              onChange={(e) =>
                setEditing({
                  ...editing,
                  tags: e.target.value
                    .split(",")
                    .map((t) => t.trim())
                    .filter(Boolean),
                })
              }
              placeholder="git, review"
            />
            {detectVariables(editing.body).length > 0 && (
              <div className="rounded-md border border-border bg-surface-2 p-2 text-xs" data-variable-preview>
                <div className="mb-1 font-medium">{t("library.preview")}</div>
                <div className="whitespace-pre-wrap font-mono">{expandVariables(editing.body, previewValues)}</div>
                {detectVariables(editing.body).includes("issue") && (
                  <div className="mt-1 text-muted">{t("library.issueNote")}</div>
                )}
              </div>
            )}
            <DialogFooter>
              <Button variant="ghost" onClick={() => setEditing(null)}>
                {t("button.cancel")}
              </Button>
              <Button
                variant="primary"
                disabled={!editing.name.trim() || !editing.body.trim()}
                onClick={() => void save()}
              >
                {t("button.save")}
              </Button>
            </DialogFooter>
          </div>
        ) : confirmDelete ? (
          <div className="flex flex-col gap-3">
            <p>{t("library.deleteConfirm", { name: confirmDelete.name })}</p>
            <DialogFooter>
              <Button variant="ghost" onClick={() => setConfirmDelete(null)}>
                {t("button.cancel")}
              </Button>
              <Button variant="danger" onClick={() => void remove()}>
                {t("library.delete")}
              </Button>
            </DialogFooter>
          </div>
        ) : (
          <>
            <div className="flex items-center gap-2">
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={t("library.search")}
                aria-label={t("library.search")}
                className="flex-1"
              />
              <Button size="sm" variant="primary" onClick={() => setEditing({ name: "", body: "", tags: [] })}>
                {t("library.new")}
              </Button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto">
              {entries.length === 0 && <p className="py-6 text-center text-sm text-muted">{t("library.empty")}</p>}
              {entries.map((entry) => (
                <div
                  key={entry.id}
                  data-prompt-entry={entry.id}
                  className="flex items-start gap-2 border-b border-border px-1 py-2"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline gap-2">
                      <span className="truncate text-sm font-medium">{entry.name}</span>
                      <span className="text-xs text-muted">{t("library.useCount", { count: entry.uses })}</span>
                    </div>
                    <div className="truncate text-xs text-muted">{entry.body}</div>
                  </div>
                  <Button size="sm" variant="ghost" onClick={() => sendToPromptBar(entry)}>
                    {t("promptBar.send")}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => void sendToNewTask(entry)}>
                    {t("library.useInNewTask")}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(entry)}>
                    {t("library.delete")}
                  </Button>
                </div>
              ))}
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
