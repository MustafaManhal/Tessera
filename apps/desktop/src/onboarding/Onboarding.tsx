// First-run onboarding (S-14): a short, skippable tour of the app idea in four cards (agents side by side, projects
// and tasks, agents at work, review and ship). It only explains: theme, fonts, terminal-settings import, agents and
// projects live in Settings and the sidebar. `onboarding_done` in kv gates it; Skip and the last button both call
// onboardingComplete. The card never grows past the window, so the buttons stay in view at any height.
import { type ComponentType, useCallback, useEffect, useId, useRef, useState } from "react";
import { Button, cn, Icons, type LucideIcon, t } from "@tessera/ui";
import { onboarding } from "./client";

interface Slide {
  id: string;
  icon: LucideIcon;
  title: string;
  body: string;
}

const slides = (): Slide[] => [
  { id: "welcome", icon: Icons.Sparkles, title: t("onboarding.welcomeTitle"), body: t("onboarding.welcomeLine") },
  { id: "tasks", icon: Icons.GitBranch, title: t("onboarding.tasksTitle"), body: t("onboarding.tasksLine") },
  { id: "agents", icon: Icons.Bot, title: t("onboarding.agentsTitle"), body: t("onboarding.agentsLine") },
  { id: "review", icon: Icons.GitPullRequest, title: t("onboarding.reviewTitle"), body: t("onboarding.reviewLine") },
];

export function Onboarding({ onDone }: { onDone?: () => void }) {
  const titleId = useId();
  const all = slides();
  const [index, setIndex] = useState(0);
  const [busy, setBusy] = useState(false);
  const next = useRef<HTMLButtonElement>(null);
  const slide = all[index] ?? all[0];
  const last = index === all.length - 1;

  const finish = useCallback(async () => {
    setBusy(true);
    try {
      await onboarding().onboardingComplete();
      onDone?.();
    } finally {
      setBusy(false);
    }
  }, [onDone]);

  // The main button takes the focus on every card, so Enter walks through the tour.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `index` moves the focus when the card changes.
  useEffect(() => next.current?.focus(), [index]);

  if (!slide) return null;
  const Icon = slide.icon as ComponentType<{ size?: number; "aria-hidden"?: boolean }>;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-bg/80 p-4" data-onboarding>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="flex max-h-full w-full max-w-md flex-col overflow-hidden rounded-xl border border-border bg-surface shadow-dialog"
        onKeyDown={(event) => {
          if (event.key === "ArrowRight" && !last) setIndex(index + 1);
          else if (event.key === "ArrowLeft" && index > 0) setIndex(index - 1);
        }}
      >
        <div className="flex shrink-0 items-center justify-between px-5 pt-4">
          <div className="flex gap-1.5" aria-hidden>
            {all.map((s, i) => (
              <span
                key={s.id}
                className={cn("h-1.5 w-6 rounded-full", i <= index ? "bg-accent-ink" : "bg-surface-3")}
              />
            ))}
          </div>
          <Button size="sm" variant="ghost" onClick={() => void finish()} disabled={busy}>
            {t("onboarding.skip")}
          </Button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4" data-onboarding-step={slide.id}>
          <div className="flex flex-col gap-3">
            <span
              className="flex size-10 items-center justify-center rounded-lg bg-accent/15 text-accent-ink"
              aria-hidden
            >
              <Icon size={20} aria-hidden />
            </span>
            <h1 id={titleId} className="m-0 text-xl font-semibold">
              {slide.title}
            </h1>
            <p className="m-0 text-sm text-muted">{slide.body}</p>
            {last && <p className="m-0 text-xs text-muted">{t("onboarding.settingsLine")}</p>}
          </div>
        </div>

        <div className="flex shrink-0 items-center justify-between gap-2 border-t border-border px-5 py-3">
          <span className="text-xs text-muted" aria-live="polite">
            {t("onboarding.stepOf", { step: index + 1, count: all.length })}
          </span>
          <div className="flex gap-2">
            {index > 0 && (
              <Button size="sm" variant="ghost" onClick={() => setIndex(index - 1)}>
                {t("onboarding.back")}
              </Button>
            )}
            <Button
              ref={next}
              size="sm"
              onClick={() => (last ? void finish() : setIndex(index + 1))}
              loading={last && busy}
            >
              {last ? t("onboarding.finish") : index === 0 ? t("onboarding.getStarted") : t("onboarding.next")}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
