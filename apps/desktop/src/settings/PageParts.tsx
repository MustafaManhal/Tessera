// The look every Settings page shares (the Updates page set it): a title with one sentence under it, and grouped cards
// with a small heading. Rows inside a card divide themselves with a bottom border; the card hides the last one.
import type { ReactNode } from "react";

export function PageHeader({ title, lede }: { title: string; lede?: string }) {
  return (
    <header className="flex shrink-0 flex-col gap-1 px-6 pt-5 pb-3">
      <h3 className="m-0 text-xl font-semibold tracking-tight">{title}</h3>
      {lede && <p className="m-0 max-w-prose text-sm text-muted">{lede}</p>}
    </header>
  );
}

export function SettingsCard({
  title,
  lede,
  children,
  ...rest
}: { title?: string; lede?: string; children: ReactNode } & Record<`data-${string}`, string | undefined>) {
  return (
    <section className="flex flex-col gap-2" {...rest}>
      {(title || lede) && (
        <div className="flex flex-col gap-0.5 px-1">
          {title && <h4 className="m-0 text-sm font-semibold">{title}</h4>}
          {lede && <p className="m-0 max-w-prose text-sm text-muted">{lede}</p>}
        </div>
      )}
      <div className="overflow-hidden rounded-lg border border-border bg-surface-2/40 px-4">
        <div className="-mb-px">{children}</div>
      </div>
    </section>
  );
}

/** `PageParts.Card` for callers that import one name. */
export const PageParts = { Card: SettingsCard, Header: PageHeader };
