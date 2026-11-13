// biome-ignore-all lint/a11y/useSemanticElements: combobox, listbox, option and group are the APG listbox pattern; the input keeps the focus.
// biome-ignore-all lint/a11y/noNoninteractiveElementToInteractiveRole: the list and its items carry the listbox and option roles.
// biome-ignore-all lint/a11y/useKeyWithClickEvents: the combobox input handles the keys for every option.
// biome-ignore-all lint/a11y/useFocusableInteractive: options are not focusable by design (aria-activedescendant on the combobox).
// The theme picker (S-12, FR-66): a searchable list of the bundled, built-in and imported themes with a live preview pane.
// A combobox over a listbox (APG): arrows move the highlight and preview the theme on the real terminals at once, Enter
// applies it to the chosen slot (light or dark mode) through `settings_set`, Esc closes and puts the old theme back.
// Filters: light, dark, high contrast, favourites, imported. Import: .itermcolors, Ghostty and Windows Terminal files.
import {
  Button,
  cn,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  IconButton,
  Icons,
  Input,
  Select,
  type StringKey,
  t,
  useToast,
} from "@tessera/ui";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useSettingsClient } from "../settings/provider";
import { configApplied } from "../store/configSlice";
import { useAppDispatch, useAppSelector } from "../store/hooks";
import { announce, setThemePickerOpen } from "../store/uiSlice";
import { favouriteToggled, previewSet, themeRemoved, themesImported } from "../store/themesSlice";
import { currentMode } from "../terminal/theme";
import { builtinThemes, BUILTIN_NAMES, isBuiltinName, loadBundledThemes } from "./catalog";
import { ANSI_NAMES, type Appearance, contrastOf, isHighContrast, type Theme, themeIssues } from "./model";
import { parseThemeFile, ThemeParseError } from "./parsers";

type Filter = "all" | "light" | "dark" | "contrast" | "favourites" | "imported";
const FILTERS: Filter[] = ["all", "light", "dark", "contrast", "favourites", "imported"];

function ansiName(index: number): string {
  const base = t(`theme.ansi.${ANSI_NAMES[index % 8] ?? "black"}` as StringKey);
  return index >= 8 ? t("theme.ansi.bright", { name: base.toLowerCase() }) : base;
}

export function ThemePicker() {
  const open = useAppSelector((state) => state.ui.themePickerOpen);
  const dispatch = useAppDispatch();
  return (
    <Dialog open={open} onOpenChange={(next) => dispatch(setThemePickerOpen(next))}>
      {open && (
        <DialogContent
          className="h-[min(40rem,calc(100vh-4rem))] max-w-5xl gap-0 p-0"
          aria-describedby="theme-description"
        >
          <DialogTitle className="sr-only">{t("theme.title")}</DialogTitle>
          <DialogDescription id="theme-description" className="sr-only">
            {t("theme.description")}
          </DialogDescription>
          <PickerBody />
        </DialogContent>
      )}
    </Dialog>
  );
}

function PickerBody() {
  const dispatch = useAppDispatch();
  const client = useSettingsClient();
  const { toast } = useToast();
  const imported = useAppSelector((state) => state.themes.imported);
  const favourites = useAppSelector((state) => state.themes.favourites);
  const appearance = useAppSelector((state) => state.config.values?.appearance) as Record<string, unknown> | undefined;
  const [bundled, setBundled] = useState<Theme[] | null>(null);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [slot, setSlot] = useState<Appearance>(currentMode);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const fileInput = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const listId = useId();

  useEffect(() => {
    let cancelled = false;
    void loadBundledThemes().then((list) => !cancelled && setBundled(list));
    return () => {
      cancelled = true;
    };
  }, []);
  // Closing (by any route) puts the configured theme back on the terminals.
  useEffect(() => () => void dispatch(previewSet(null)), [dispatch]);

  const configured = (mode: Appearance) =>
    String(appearance?.[mode === "dark" ? "theme-dark" : "theme-light"] ?? BUILTIN_NAMES[mode]);
  const isCurrent = (theme: Theme) => {
    const name = configured(slot);
    return (
      theme.name === name ||
      (isBuiltinName(name) &&
        isBuiltinName(theme.name) &&
        theme.appearance === (name === "Tessera Night" ? "dark" : "light"))
    );
  };

  const all = useMemo(() => {
    const seen = new Set<string>();
    return [...builtinThemes(), ...imported, ...(bundled ?? [])].filter((theme) => {
      if (seen.has(theme.id)) return false;
      seen.add(theme.id);
      return true;
    });
  }, [imported, bundled]);

  const visible = useMemo(() => {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    return all.filter((theme) => {
      if (filter === "light" && theme.appearance !== "light") return false;
      if (filter === "dark" && theme.appearance !== "dark") return false;
      if (filter === "contrast" && !isHighContrast(theme)) return false;
      if (filter === "favourites" && !favourites.includes(theme.id)) return false;
      if (filter === "imported" && !theme.imported) return false;
      return words.every((word) => theme.name.toLowerCase().includes(word));
    });
  }, [all, query, filter, favourites]);

  // The highlight starts on the theme in use; leaving the filtered list moves it to the first match.
  const shown = visible.find((theme) => theme.id === activeId) ?? visible.find(isCurrent) ?? visible[0] ?? null;
  const shownId = shown?.id ?? null;
  // biome-ignore lint/correctness/useExhaustiveDependencies: preview the highlighted theme; `shown` changes with `shownId`.
  useEffect(() => {
    dispatch(previewSet(shown && !(isBuiltinName(shown.name) && isCurrent(shown)) ? shown : null));
  }, [shownId, dispatch]);
  useEffect(() => {
    if (shownId)
      listRef.current?.querySelector(`[data-theme-id="${CSS.escape(shownId)}"]`)?.scrollIntoView({ block: "nearest" });
  }, [shownId]);

  const move = (offset: number | "start" | "end") => {
    if (visible.length === 0) return;
    const index = visible.findIndex((theme) => theme.id === shownId);
    const next =
      offset === "start"
        ? 0
        : offset === "end"
          ? visible.length - 1
          : Math.min(visible.length - 1, Math.max(0, index + offset));
    setActiveId(visible[next]?.id ?? null);
  };

  const apply = async (theme: Theme | null = shown) => {
    if (!theme) return;
    const key = slot === "dark" ? "theme-dark" : "theme-light";
    try {
      const next = await client.set({ appearance: { [key]: theme.name } });
      dispatch(configApplied(next));
      dispatch(previewSet(null));
      dispatch(announce(t("theme.applied", { name: theme.name, mode: t(`theme.slot.${slot}`).toLowerCase() })));
      toast({ title: t("theme.applied", { name: theme.name, mode: t(`theme.slot.${slot}`).toLowerCase() }) });
      dispatch(setThemePickerOpen(false));
    } catch (cause) {
      toast({
        kind: "error",
        title: t("theme.applyFailed", { message: cause instanceof Error ? cause.message : String(cause) }),
      });
    }
  };

  const importFiles = async (files: FileList | File[]) => {
    const found: Theme[] = [];
    const problems: string[] = [];
    for (const file of Array.from(files)) {
      try {
        found.push(...parseThemeFile(await file.text(), file.name));
      } catch (cause) {
        const reason =
          cause instanceof ThemeParseError
            ? t(`theme.parse.${cause.reason}` as StringKey, { detail: cause.detail })
            : t("theme.parse.badRead");
        problems.push(t("theme.importFailed", { file: file.name, reason }));
      }
    }
    setErrors(problems);
    if (found.length > 0) {
      dispatch(themesImported(found));
      setFilter("all");
      setQuery("");
      setActiveId(found[0]?.id ?? null);
      toast({ title: t("theme.importDone", { count: found.length }) });
    }
  };

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: a drop target for theme files; the controls inside have the keyboard.
    <div
      className="flex min-h-0 flex-1"
      data-theme-picker
      onDragOver={(event) => {
        if (event.dataTransfer.types.includes("Files")) event.preventDefault();
      }}
      onDrop={(event) => {
        if (!event.dataTransfer.types.includes("Files")) return;
        event.preventDefault();
        void importFiles(event.dataTransfer.files);
      }}
    >
      <div className="flex w-80 shrink-0 flex-col border-e border-border">
        <div className="flex flex-col gap-2 p-3 pe-3">
          <p className="text-lg font-semibold" aria-hidden>
            {t("theme.title")}
          </p>
          <div className="relative">
            <Icons.Search size={14} className="pointer-events-none absolute start-2 top-2.5 text-muted" aria-hidden />
            <Input
              role="combobox"
              type="search"
              aria-label={t("theme.search")}
              aria-expanded="true"
              aria-controls={listId}
              aria-activedescendant={
                shownId ? `${listId}-${visible.findIndex((theme) => theme.id === shownId)}` : undefined
              }
              aria-autocomplete="list"
              placeholder={t("theme.searchPlaceholder", { count: all.length })}
              className="ps-7"
              autoFocus
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "ArrowDown") move(1);
                else if (event.key === "ArrowUp") move(-1);
                else if (event.key === "PageDown") move(8);
                else if (event.key === "PageUp") move(-8);
                else if (event.key === "Home" && (event.ctrlKey || event.metaKey)) move("start");
                else if (event.key === "End" && (event.ctrlKey || event.metaKey)) move("end");
                else if (event.key === "Enter") void apply();
                else return;
                event.preventDefault();
              }}
            />
          </div>
          <div role="group" aria-label={t("theme.filters")} className="flex flex-wrap gap-1">
            {FILTERS.map((id) => (
              <button
                key={id}
                type="button"
                aria-pressed={filter === id}
                className="h-6 cursor-default rounded-full border border-border px-2 text-xs text-muted hover:bg-surface-2 aria-pressed:border-accent aria-pressed:bg-surface-3 aria-pressed:text-fg"
                onClick={() => setFilter(id)}
              >
                {t(`theme.filter.${id}` as StringKey)}
              </button>
            ))}
          </div>
        </div>
        {bundled === null ? (
          <p className="px-3 py-2 text-sm text-muted" role="status">
            {t("theme.loading")}
          </p>
        ) : visible.length === 0 ? (
          <p className="px-3 py-2 text-sm text-muted" role="status">
            {t("theme.noMatches")}
          </p>
        ) : (
          <ul
            id={listId}
            ref={listRef}
            role="listbox"
            aria-label={t("theme.list")}
            className="m-0 min-h-0 flex-1 list-none overflow-y-auto px-1 pb-2"
          >
            {visible.map((theme, index) => (
              <li
                key={theme.id}
                id={`${listId}-${index}`}
                role="option"
                aria-selected={theme.id === shownId}
                data-theme-id={theme.id}
                data-current={isCurrent(theme) || undefined}
                style={{ contentVisibility: "auto", containIntrinsicSize: "0 32px" }}
                className={cn(
                  "group flex h-8 cursor-default items-center gap-2 rounded-md px-2 text-base",
                  theme.id === shownId ? "bg-surface-3" : "hover:bg-surface-2",
                )}
                onMouseEnter={() => setActiveId(theme.id)}
                onClick={() => setActiveId(theme.id)}
                onDoubleClick={() => void apply(theme)}
              >
                <Swatches theme={theme} />
                <span className="min-w-0 flex-1 truncate">{theme.name}</span>
                {isCurrent(theme) && (
                  <Icons.Check size={14} className="shrink-0 text-accent" aria-label={t("theme.current")} />
                )}
                {theme.imported && (
                  <IconButton
                    size="sm"
                    icon={Icons.Trash2}
                    tabIndex={-1}
                    label={t("theme.remove", { name: theme.name })}
                    onClick={(event) => {
                      event.stopPropagation();
                      dispatch(themeRemoved(theme.id));
                    }}
                  />
                )}
                <IconButton
                  size="sm"
                  icon={favourites.includes(theme.id) ? Icons.Star : Icons.StarOff}
                  tabIndex={-1}
                  aria-pressed={favourites.includes(theme.id)}
                  label={t(favourites.includes(theme.id) ? "theme.unfavourite" : "theme.favourite", {
                    name: theme.name,
                  })}
                  onClick={(event) => {
                    event.stopPropagation();
                    dispatch(favouriteToggled(theme.id));
                  }}
                />
              </li>
            ))}
          </ul>
        )}
        <div className="flex flex-col gap-2 border-t border-border p-3">
          <input
            ref={fileInput}
            type="file"
            multiple
            hidden
            data-theme-file
            accept=".itermcolors,.json,.conf,.theme,.txt"
            onChange={(event) => {
              if (event.target.files) void importFiles(event.target.files);
              event.target.value = "";
            }}
          />
          <Button size="sm" icon={Icons.Upload} onClick={() => fileInput.current?.click()}>
            {t("theme.import")}
          </Button>
          <p className="text-xs text-muted">{t("theme.importHint")}</p>
          {errors.map((message) => (
            <p key={message} role="alert" className="text-xs text-danger" data-import-error>
              {message}
            </p>
          ))}
        </div>
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-3 p-4 pe-12">
        {shown ? <Preview theme={shown} /> : null}
        <div className="mt-auto flex flex-wrap items-end gap-3">
          <div className="w-44">
            <label htmlFor="theme-slot" className="text-xs text-muted">
              {t("theme.applyTo")}
            </label>
            <Select
              id="theme-slot"
              value={slot}
              options={(["light", "dark"] as const).map((mode) => ({ value: mode, label: t(`theme.slot.${mode}`) }))}
              onValueChange={(value) => setSlot(value as Appearance)}
            />
          </div>
          <Button variant="primary" icon={Icons.Check} disabled={!shown} onClick={() => void apply()}>
            {t("theme.apply")}
          </Button>
        </div>
      </div>
    </div>
  );
}

function Swatches({ theme }: { theme: Theme }) {
  return (
    <span aria-hidden className="flex h-4 w-14 shrink-0 overflow-hidden rounded-sm border border-border">
      <span className="w-3" style={{ background: theme.background }} />
      {[1, 2, 3, 4, 5, 6].map((index) => (
        <span key={index} className="w-[0.6rem]" style={{ background: theme.ansi[index] }} />
      ))}
    </span>
  );
}

/** A mock terminal in the theme's own colours, its 16 swatches, and what is wrong with its contrast. */
function Preview({ theme }: { theme: Theme }) {
  const c = (index: number) => ({ color: theme.ansi[index] });
  const issues = themeIssues(theme);
  const ratio = contrastOf(theme.foreground, theme.background).toFixed(1);
  return (
    <section
      aria-label={t("theme.preview", { name: theme.name })}
      className="flex flex-col gap-3"
      data-theme-preview={theme.name}
    >
      <h3 className="text-lg font-semibold">{theme.name}</h3>
      <pre
        className="m-0 overflow-x-auto rounded-lg border border-border p-3 font-mono text-sm leading-relaxed"
        style={{ background: theme.background, color: theme.foreground }}
      >
        <span style={c(2)}>~/code/shop-api</span> <span style={c(6)}>main</span> <span style={c(5)}>❯</span>{" "}
        {t("theme.sample.ls")}
        {"\n"}
        <span style={c(4)}>src/</span> <span style={c(4)}>tests/</span> <span style={c(1)}>build.zip</span>{" "}
        <span style={c(3)}>README.md</span> <span style={c(10)}>run.sh</span>
        {"\n"}
        <span style={c(2)}>~/code/shop-api</span> <span style={c(6)}>main</span> <span style={c(5)}>❯</span>{" "}
        {t("theme.sample.diff")}
        {"\n"}
        <span style={c(6)}>@@ -12,3 +12,3 @@</span>
        {"\n"}
        <span style={c(1)}>- const total = price * qty;</span>
        {"\n"}
        <span style={c(2)}>+ const total = round(price * qty);</span>
        {"\n"}
        <span style={c(10)}>✓ {t("theme.sample.ok")}</span> <span style={c(9)}>✗ {t("theme.sample.fail")}</span>
        {"\n"}
        <span style={{ background: theme.selection }}> selected text </span>{" "}
        <span style={{ background: theme.cursor, color: theme.background }}> </span>
      </pre>
      <div role="group" aria-label={t("theme.swatches")} className="grid grid-cols-8 gap-1">
        {theme.ansi.map((colour, index) => (
          <span
            // biome-ignore lint/suspicious/noArrayIndexKey: the 16 colours are positional.
            key={index}
            title={`${ansiName(index)} ${colour}`}
            role="img"
            aria-label={`${ansiName(index)} ${colour}`}
            className="h-6 rounded-sm border border-border"
            style={{ background: colour }}
          />
        ))}
      </div>
      <p className="text-xs text-muted" data-contrast>
        {t("theme.contrast.ok", { ratio })}
      </p>
      {issues.map((issue) => (
        <p
          key={issue.kind === "ansi" ? `a${issue.index}` : "fg"}
          role="note"
          className="rounded-md border border-border bg-st-needs-tint px-3 py-2 text-sm"
          data-theme-warning
        >
          {issue.kind === "foreground"
            ? t("theme.warn.foreground", { ratio: issue.ratio.toFixed(1) })
            : t("theme.warn.ansi", { name: ansiName(issue.index), ratio: issue.ratio.toFixed(1) })}
        </p>
      ))}
    </section>
  );
}
