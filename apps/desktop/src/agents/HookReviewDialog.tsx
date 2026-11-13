// The hook review dialog (M6.4): before Install, Update or Remove touches an agent's config file, the user sees the
// file path and the unified diff (added and removed lines in the status colours), the backup note, and confirms or
// cancels. A conflict, an unreadable file or an unsupported agent explains itself instead of showing a diff.
import { Button, cn, Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle, t } from "@tessera/ui";
import { useMemo } from "react";
import { classifyDiffLine, diffLines } from "./hookDiff";
import type { AgentInfo, HookChange } from "./types";

export type HookAction = "install" | "update" | "remove";

const LINE_CLASS: Record<ReturnType<typeof classifyDiffLine>, string> = {
  add: "text-st-success",
  remove: "text-st-error",
  hunk: "text-muted",
  meta: "text-muted",
  context: "text-fg",
};

function HookDiff({ diff, label }: { diff: string; label: string }) {
  const lines = useMemo(() => diffLines(diff), [diff]);
  // biome-ignore-start lint/a11y/noNoninteractiveTabindex: a scrollable diff must take keyboard focus to scroll.
  return (
    <section
      aria-label={label}
      data-hook-diff
      tabIndex={0}
      className="max-h-64 overflow-auto rounded-md border border-border bg-surface-2 p-2 font-mono text-sm leading-5 focus-visible:outline-2 focus-visible:outline-focus"
    >
      {lines.map((line, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: diff rows are positional; the same line can repeat.
        <div key={index} className={cn("whitespace-pre", LINE_CLASS[classifyDiffLine(line)])}>
          {line || " "}
        </div>
      ))}
    </section>
  );
  // biome-ignore-end lint/a11y/noNoninteractiveTabindex: end of the scrollable diff region
}

export function HookReviewDialog({
  agent,
  action,
  change,
  open,
  busy,
  error,
  onConfirm,
  onClose,
}: {
  agent: AgentInfo;
  action: HookAction;
  change: HookChange;
  open: boolean;
  busy: boolean;
  error: string | null;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const confirmLabel =
    action === "remove"
      ? t("agents.hooks.confirmRemove")
      : action === "update"
        ? t("agents.hooks.confirmUpdate")
        : t("agents.hooks.confirmInstall");
  const explanation =
    change.state === "conflict"
      ? t("agents.hooks.explain.conflict", { agent: agent.name })
      : change.state === "unparseable"
        ? t("agents.hooks.explain.unparseable", { path: change.config_path })
        : change.state === "unsupported"
          ? t("agents.hooks.explain.unsupported", { agent: agent.name })
          : null;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !busy) onClose();
      }}
    >
      <DialogContent data-hook-review>
        <DialogTitle>{t("agents.hooks.reviewTitle")}</DialogTitle>
        <DialogDescription>
          {change.config_path
            ? t("agents.hooks.reviewFor", { agent: agent.name, path: change.config_path })
            : agent.name}
        </DialogDescription>
        {explanation ? (
          <p className="text-base text-fg" role="note">
            {explanation}
          </p>
        ) : (
          <>
            <HookDiff diff={change.diff} label={t("agents.hooks.reviewTitle")} />
            <p className="text-sm text-muted">
              {t("agents.hooks.backup", { file: `${change.config_path}.tessera.bak` })}
            </p>
          </>
        )}
        {error && (
          <p role="alert" className="text-sm text-st-error">
            {error}
          </p>
        )}
        <DialogFooter>
          <Button variant="ghost" disabled={busy} onClick={onClose}>
            {t("agents.hooks.cancel")}
          </Button>
          {!explanation && (
            <Button variant={action === "remove" ? "danger" : "primary"} disabled={busy} onClick={onConfirm}>
              {confirmLabel}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
