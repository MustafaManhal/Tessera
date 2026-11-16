// The sidebar's filter: one icon that opens a small panel with a name search and a choice of which tasks to show (all,
// active, not active, archived). The icon carries a dot while anything is filtered.
import { Button, Icons, IconButton, Input, t } from "@tessera/ui";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { useAppDispatch, useAppSelector } from "../store/hooks";
import {
  selectProjectsFilter,
  selectSortMode,
  selectStatusFilter,
  setFilter,
  setStatusFilter,
  type SortMode,
  type StatusFilter,
} from "../store/projectsSlice";
import { chooseSortMode } from "./projectActions";

const CHOICES: { id: StatusFilter; label: Parameters<typeof t>[0] }[] = [
  { id: "all", label: "sidebar.filter.all" },
  { id: "active", label: "sidebar.filter.active" },
  { id: "inactive", label: "sidebar.filter.inactive" },
  { id: "archived", label: "sidebar.filter.archived" },
];

const SORTS: { id: SortMode; label: Parameters<typeof t>[0] }[] = [
  { id: "active", label: "sidebar.sort.active" },
  { id: "manual", label: "sidebar.sort.manual" },
];

/** Lets the tree's keys ("/") open the panel and put the cursor in the search box. */
export const OPEN_FILTER_EVENT = "tessera:open-filter";

/** `trailing` sits at the end of the same row as the filter icon (the sidebar puts "Add project" there). */
export function FilterMenu({
  onArrowDown,
  trailing,
  title,
}: {
  onArrowDown: () => void;
  trailing?: ReactNode;
  title?: string;
}) {
  const dispatch = useAppDispatch();
  const text = useAppSelector(selectProjectsFilter);
  const status = useAppSelector(selectStatusFilter);
  const sort = useAppSelector(selectSortMode);
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const active = text.trim() !== "" || status !== "all";

  useEffect(() => {
    const onOpen = () => {
      setOpen(true);
      requestAnimationFrame(() => document.getElementById("sidebar-filter")?.focus());
    };
    window.addEventListener(OPEN_FILTER_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_FILTER_EVENT, onOpen);
  }, []);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (root.current && !root.current.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [open]);

  return (
    <div className="relative px-2 pt-2 pb-2" ref={root}>
      <div className="flex items-center gap-1">
        {title && !active && <h2 className="m-0 ms-1 me-auto text-xs font-semibold text-muted">{title}</h2>}
        <span className="relative inline-flex">
          <IconButton
            size="sm"
            icon={Icons.ListFilter}
            label={t("sidebar.filter")}
            aria-expanded={open}
            aria-haspopup="dialog"
            data-sidebar-filter-button
            className={active ? "text-accent-ink" : undefined}
            onClick={() => setOpen((value) => !value)}
          />
          {active && (
            <span
              aria-hidden
              data-filter-dot
              className="pointer-events-none absolute -top-0.5 -end-0.5 size-2 rounded-full bg-accent-ink"
            />
          )}
        </span>
        {active && (
          <span className="flex min-w-0 items-center gap-1 text-xs text-muted" data-filter-summary>
            <span className="truncate">
              {[
                text.trim(),
                status !== "all" ? t(CHOICES.find((c) => c.id === status)?.label ?? "sidebar.filter.all") : "",
              ]
                .filter(Boolean)
                .join(" · ")}
            </span>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                dispatch(setFilter(""));
                dispatch(setStatusFilter("all"));
              }}
            >
              {t("sidebar.filter.clear")}
            </Button>
          </span>
        )}
        {trailing && <span className="flex shrink-0 items-center">{trailing}</span>}
      </div>
      {open && (
        <div
          role="dialog"
          aria-label={t("sidebar.filter")}
          data-sidebar-filter-panel
          className="absolute start-2 top-9 z-40 flex w-60 max-w-[calc(100%-1rem)] flex-col gap-3 rounded-lg border border-border bg-surface p-3 shadow-lg"
        >
          <div className="relative">
            <Icons.Search size={14} className="pointer-events-none absolute start-2 top-2.5 text-muted" aria-hidden />
            <Input
              id="sidebar-filter"
              type="search"
              aria-label={t("sidebar.filter")}
              placeholder={t("sidebar.filterPlaceholder")}
              className="ps-7"
              value={text}
              onChange={(event) => dispatch(setFilter(event.target.value))}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.stopPropagation();
                  if (text) dispatch(setFilter(""));
                  else setOpen(false);
                } else if (event.key === "ArrowDown") {
                  event.preventDefault();
                  onArrowDown();
                }
              }}
            />
          </div>
          <fieldset className="m-0 flex min-w-0 flex-col gap-0.5 border-0 p-0">
            <legend className="px-1 pb-1 text-xs font-medium text-muted">{t("sidebar.filter.show")}</legend>
            {CHOICES.map((choice) => (
              <button
                key={choice.id}
                type="button"
                aria-pressed={status === choice.id}
                data-status-filter={choice.id}
                className="flex h-8 w-full cursor-pointer items-center gap-2 rounded-md border-0 bg-transparent px-2 text-start text-sm text-fg hover:bg-surface-2 aria-pressed:bg-surface-3 aria-pressed:font-medium"
                onClick={() => dispatch(setStatusFilter(choice.id))}
              >
                <span className="grid size-4 place-items-center">
                  {status === choice.id && <Icons.Check size={14} aria-hidden />}
                </span>
                {t(choice.label)}
              </button>
            ))}
          </fieldset>
          <fieldset className="m-0 flex min-w-0 flex-col gap-0.5 border-0 p-0">
            <legend className="px-1 pb-1 text-xs font-medium text-muted">{t("sidebar.sort.title")}</legend>
            {SORTS.map((choice) => (
              <button
                key={choice.id}
                type="button"
                aria-pressed={sort === choice.id}
                data-sort-mode={choice.id}
                className="flex h-8 w-full cursor-pointer items-center gap-2 rounded-md border-0 bg-transparent px-2 text-start text-sm text-fg hover:bg-surface-2 aria-pressed:bg-surface-3 aria-pressed:font-medium"
                onClick={() => dispatch(chooseSortMode(choice.id))}
              >
                <span className="grid size-4 place-items-center">
                  {sort === choice.id && <Icons.Check size={14} aria-hidden />}
                </span>
                {t(choice.label)}
              </button>
            ))}
          </fieldset>
        </div>
      )}
    </div>
  );
}
