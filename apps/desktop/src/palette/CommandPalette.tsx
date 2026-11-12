// The command palette (S-10, FR-64): Mod+K or Mod+Shift+P. A Radix dialog (focus trapped, Esc closes) around cmdk's
// keyboard-driven list. We filter and rank ourselves (`shouldFilter={false}`) to highlight the matched letters and to
// put recent actions first when the query is empty. Unavailable actions stay listed, dimmed, with the reason.
// Prefixes: ">" actions (the only kind today). Reserved for later: "#" tasks, "@" projects, "/" files.
import { cn, Dialog, DialogContent, DialogDescription, DialogTitle, getPlatform, Icons, Kbd, t } from "@tessera/ui";
import { Command } from "cmdk";
import { shallowEqual } from "react-redux";
import { useMemo, useRef, useState } from "react";
import { actionLabel, actions, availability, primaryShortcut, reasonText, runAction } from "../actions/registry";
import { useAppDispatch, useAppSelector } from "../store/hooks";
import { noteRecent, setPaletteOpen } from "../store/uiSlice";
import { type Entry, highlightRuns, paletteSections } from "./sections";

function Highlighted({ text, indices }: { text: string; indices: readonly number[] }) {
  if (indices.length === 0) return <>{text}</>;
  return (
    <>
      {highlightRuns(text, indices).map((run) =>
        run.hit ? (
          <mark
            key={run.start}
            className="bg-transparent font-semibold text-fg underline decoration-accent underline-offset-2"
          >
            {run.text}
          </mark>
        ) : (
          <span key={run.start}>{run.text}</span>
        ),
      )}
    </>
  );
}

export function CommandPalette() {
  const open = useAppSelector((state) => state.ui.paletteOpen);
  const recent = useAppSelector((state) => state.ui.recentActions);
  // The whole state: actions' availability can depend on any slice.
  const state = useAppSelector((root) => ({ ...root }), shallowEqual);
  const dispatch = useAppDispatch();
  const [query, setQuery] = useState("");
  const pending = useRef<string | null>(null);
  const previous = useRef<HTMLElement | null>(null);
  const platform = getPlatform();

  const entries = useMemo(() => {
    const ctx = { layout: state.layout, state, dispatch };
    return actions
      .filter((action) => action.id !== "view.palette")
      .map((action) => ({ action, label: actionLabel(action, ctx), available: availability(action, ctx) }))
      .filter((entry) => entry.available.ok || !entry.action.hideWhenUnavailable);
  }, [state, dispatch]);
  const sections = useMemo(() => paletteSections(query, entries, recent), [query, entries, recent]);

  const choose = (entry: Entry) => {
    if (!entry.available.ok) return;
    pending.current = entry.action.id;
    dispatch(noteRecent(entry.action.id));
    dispatch(setPaletteOpen(false));
  };

  return (
    <Dialog open={open} onOpenChange={(next) => dispatch(setPaletteOpen(next))}>
      {open && (
        <DialogContent
          hideClose
          aria-describedby={undefined}
          className="max-w-160 gap-0 self-start overflow-hidden p-0 [margin-top:12vh]"
          onOpenAutoFocus={() => {
            previous.current = document.activeElement as HTMLElement | null;
            pending.current = null;
            setQuery("");
          }}
          onCloseAutoFocus={(event) => {
            // Focus goes back where it was; then a chosen action runs (it may move focus on purpose, e.g. into a
            // new pane), now that the dialog no longer traps it.
            event.preventDefault();
            previous.current?.focus({ preventScroll: true });
            const id = pending.current;
            pending.current = null;
            if (id) runAction(id);
          }}
        >
          <DialogTitle className="sr-only">{t("palette.label")}</DialogTitle>
          <Command label={t("palette.label")} shouldFilter={false} loop className="flex flex-col">
            <div className="flex items-center gap-2 border-b border-border px-4">
              <Icons.Search size={16} aria-hidden className="shrink-0 text-muted" />
              <Command.Input
                value={query}
                onValueChange={setQuery}
                placeholder={t("palette.placeholder")}
                className="h-12 min-w-0 flex-1 bg-transparent text-lg text-fg outline-none placeholder:text-muted"
              />
            </div>
            <Command.List className="max-h-[min(60vh,26rem)] overflow-y-auto p-1">
              <Command.Empty className="px-3 py-8 text-center text-base text-muted">{t("palette.empty")}</Command.Empty>
              {sections.map((section) => (
                <Command.Group
                  key={section.heading ?? "results"}
                  heading={section.heading ? t(section.heading) : undefined}
                  className="[&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-muted"
                >
                  {section.items.map(({ entry, match }) => {
                    const reason = reasonText(entry.available);
                    const shortcut = primaryShortcut(entry.action.id, platform);
                    return (
                      <Command.Item
                        key={entry.action.id}
                        value={entry.action.id}
                        disabled={!entry.available.ok}
                        onSelect={() => choose(entry)}
                        className={cn(
                          "flex h-8 cursor-default items-center gap-3 rounded-md px-3 text-base select-none",
                          "data-[selected=true]:bg-surface-3",
                          entry.available.ok ? "text-fg" : "text-muted",
                        )}
                      >
                        <span className="min-w-0 flex-1 truncate">
                          <Highlighted text={entry.label} indices={match?.indices ?? []} />
                        </span>
                        {reason && <span className="truncate text-sm">{reason}</span>}
                        {shortcut && <Kbd shortcut={shortcut} />}
                      </Command.Item>
                    );
                  })}
                </Command.Group>
              ))}
            </Command.List>
          </Command>
          <DialogDescription className="sr-only">{t("palette.placeholder")}</DialogDescription>
        </DialogContent>
      )}
    </Dialog>
  );
}
