import { useId, useState } from "react";
import {
  Button,
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  Input,
  Select,
  t,
} from "@tessera/ui";
import type { Skill } from "../integrations/mcp/client";
export function MarkdownPreview({ body }: { body: string }) {
  const seen = new Map<string, number>();
  const lines = body.split("\n").map((line) => {
    const count = (seen.get(line) ?? 0) + 1;
    seen.set(line, count);
    return { line, key: `${line}:${count}` };
  });
  return (
    <section
      aria-label={t("manager.markdownPreview")}
      className="space-y-2 rounded-md border border-border bg-surface-2 p-3 text-sm"
    >
      {lines.map(({ line, key }) =>
        line.startsWith("# ") ? (
          <h3 key={key} className="text-lg font-semibold">
            {line.slice(2)}
          </h3>
        ) : line.startsWith("## ") ? (
          <h4 key={key} className="font-semibold">
            {line.slice(3)}
          </h4>
        ) : (
          <p key={key} className="whitespace-pre-wrap break-words">
            {line.startsWith("- ") ? `• ${line.slice(2)}` : line || "\u00a0"}
          </p>
        ),
      )}
    </section>
  );
}
export function SkillEditor({
  initial,
  onClose,
  onSave,
}: {
  initial: Skill;
  onClose: () => void;
  onSave: (row: Skill) => Promise<void>;
}) {
  const uid = useId();
  const [row, setRow] = useState(initial),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogContent className="max-h-[90vh] overflow-auto">
        <DialogTitle>{t(initial.id ? "manager.editSkill" : "manager.addSkill")}</DialogTitle>
        <DialogDescription>{t("manager.skillHint")}</DialogDescription>
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            setBusy(true);
            setError("");
            void onSave(row)
              .catch((e) => setError(e instanceof Error ? e.message : String(e)))
              .finally(() => setBusy(false));
          }}
        >
          <label htmlFor={`${uid}-name`}>
            {t("manager.name")}
            <Input
              id={`${uid}-name`}
              required
              value={row.name}
              onChange={(e) => setRow({ ...row, name: e.target.value })}
            />
          </label>
          <label htmlFor={`${uid}-kind`}>
            {t("manager.kind")}
            <Select
              id={`${uid}-kind`}
              aria-label={t("manager.kind")}
              value={row.kind}
              options={(["agents_md", "claude_skill", "rules_file"] as const).map((value) => ({
                value,
                label: t(`manager.kind.${value}`),
              }))}
              onValueChange={(kind) => setRow({ ...row, kind: kind as Skill["kind"] })}
            />
          </label>
          <label>
            {t("manager.markdown")}
            <textarea
              required
              rows={8}
              className="w-full rounded-md border border-border bg-bg p-2 font-mono text-sm"
              value={row.body}
              onChange={(e) => setRow({ ...row, body: e.target.value })}
            />
          </label>
          <MarkdownPreview body={row.body} />
          {error && (
            <p role="alert" className="text-sm text-st-error">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button variant="ghost" disabled={busy} onClick={onClose}>
              {t("button.cancel")}
            </Button>
            <Button type="submit" disabled={busy || !row.body.trim() || !row.name.trim()}>
              {t("manager.save")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
