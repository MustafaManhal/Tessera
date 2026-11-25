// What a tab shows about its panes besides the title: a progress ring (OSC 9;4: normal %, error, indeterminate,
// paused) and a badge dot ("a command finished", "failed", "new notification") until the pane is looked at.
// Both carry text for screen readers; the ring spins only without reduced motion.
import { cn, t } from "@tessera/ui";
import { useMemo } from "react";
import { paneIds, type Tab } from "../layout";
import { type BadgeKind, combineProgress, type PaneProgress } from "../store/attentionSlice";
import { useAppSelector } from "../store/hooks";

const RADIUS = 5;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

const RING_COLOUR: Record<PaneProgress["state"], string> = {
  normal: "stroke-accent",
  indeterminate: "stroke-accent",
  error: "stroke-st-error",
  paused: "stroke-st-needs",
};

function progressLabel(progress: PaneProgress): string {
  const percent = progress.value ?? 0;
  switch (progress.state) {
    case "normal":
      return t("tab.progress.normal", { percent });
    case "error":
      return t("tab.progress.error");
    case "indeterminate":
      return t("tab.progress.indeterminate");
    case "paused":
      return t("tab.progress.paused", { percent });
  }
}

export function TabProgress({ tab }: { tab: Tab }) {
  const all = useAppSelector((state) => state.attention.progress);
  const progress = useMemo(
    () => combineProgress(paneIds(tab.root).flatMap((id) => (all[id] ? [all[id]] : []))),
    [all, tab.root],
  );
  if (!progress) return null;
  const fraction =
    progress.state === "indeterminate" ? 0.25 : progress.state === "error" ? 1 : (progress.value ?? 0) / 100;
  return (
    <span
      className="flex shrink-0 items-center"
      data-progress-state={progress.state}
      data-progress-value={progress.value ?? ""}
    >
      <svg
        aria-hidden
        viewBox="0 0 14 14"
        className={cn(
          "size-3.5 -rotate-90",
          progress.state === "indeterminate" && "animate-spin motion-reduce:animate-none",
        )}
      >
        <circle cx="7" cy="7" r={RADIUS} fill="none" strokeWidth="2" className="stroke-border" />
        <circle
          cx="7"
          cy="7"
          r={RADIUS}
          fill="none"
          strokeWidth="2"
          strokeLinecap="round"
          className={RING_COLOUR[progress.state]}
          strokeDasharray={`${fraction * CIRCUMFERENCE} ${CIRCUMFERENCE}`}
        />
      </svg>
      <span className="sr-only">, {progressLabel(progress)}</span>
    </span>
  );
}

const BADGE: Record<
  BadgeKind,
  { colour: string; label: "tab.badge.finished" | "tab.badge.failed" | "tab.badge.notification" }
> = {
  finished: { colour: "bg-st-done", label: "tab.badge.finished" },
  failed: { colour: "bg-st-error", label: "tab.badge.failed" },
  notification: { colour: "bg-accent-ink", label: "tab.badge.notification" },
};

const ORDER: BadgeKind[] = ["failed", "finished", "notification"];

export function TabBadge({ tab }: { tab: Tab }) {
  const badges = useAppSelector((state) => state.attention.badges);
  const agentAttention = useAppSelector((state) => state.attention.agentAttention);
  const attention = useMemo(() => {
    const marks = paneIds(tab.root).flatMap((id) => (agentAttention[id] ? [agentAttention[id]] : []));
    // needs_input outranks done when a tab has both.
    return marks.find((mark) => mark.kind === "needs_input") ?? marks[0] ?? null;
  }, [agentAttention, tab.root]);
  const kind = useMemo(() => {
    if (attention) return null;
    const kinds = new Set(paneIds(tab.root).flatMap((id) => (badges[id] ? [badges[id].kind] : [])));
    return ORDER.find((candidate) => kinds.has(candidate)) ?? null;
  }, [attention, badges, tab.root]);
  if (attention) {
    return (
      <span
        className="flex shrink-0 items-center"
        data-badge={attention.kind === "needs_input" ? "agent-needs" : "agent-done"}
      >
        <span
          aria-hidden
          className={cn("size-2 rounded-full", attention.kind === "needs_input" ? "bg-st-needs" : "bg-st-done")}
        />
        <span className="sr-only">
          , {t(attention.kind === "needs_input" ? "attention.agentNeedsInput" : "attention.agentDone")}
        </span>
      </span>
    );
  }
  if (!kind) return null;
  const badge = BADGE[kind];
  return (
    <span className="flex shrink-0 items-center" data-badge={kind}>
      <span aria-hidden className={cn("size-2 rounded-full", badge.colour)} />
      <span className="sr-only">, {t(badge.label)}</span>
    </span>
  );
}
