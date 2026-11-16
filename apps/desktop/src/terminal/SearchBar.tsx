// The scrollback search bar (FR-05, S-03): Cmd/Ctrl+F opens it, Enter / Shift+Enter move between matches, Esc closes
// and returns focus to the terminal. Case, whole word and regex toggles; "3 of 17"; an invalid regex is reported
// inline instead of searching.
import type { SearchOptions, SearchResults, TerminalEngine } from "@tessera/term";
import { cn, getPlatform, IconButton, Icons, Input, t } from "@tessera/ui";
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { primaryShortcut } from "../actions/registry";

export interface SearchBarHandle {
  focus(): void;
  find(direction: "next" | "previous"): void;
}

/** The regex error message, or null when the pattern is fine (or not a regex search). */
export function regexError(query: string, options: SearchOptions): string | null {
  if (!options.regex || query === "") return null;
  try {
    new RegExp(query, options.caseSensitive ? "" : "i");
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

export function resultText(query: string, results: SearchResults | null): string {
  if (query === "" || !results) return "";
  if (results.count <= 0) return t("search.none");
  // Past the highlight limit the addon counts up to the limit and does not place the active match.
  if (results.index < 0) return t("search.countOnly", { count: results.count });
  return t("search.count", { index: results.index + 1, count: results.count });
}

interface SearchBarProps {
  engine: TerminalEngine;
  onClose: () => void;
}

export const SearchBar = forwardRef<SearchBarHandle, SearchBarProps>(function SearchBar({ engine, onClose }, ref) {
  const input = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [options, setOptions] = useState<SearchOptions>({ caseSensitive: false, wholeWord: false, regex: false });
  const [results, setResults] = useState<SearchResults | null>(null);
  const error = regexError(query, options);
  const platform = getPlatform();

  useEffect(() => {
    const subscription = engine.onSearchResults(setResults);
    return () => subscription.dispose();
  }, [engine]);

  // Search as you type (incremental: the active match stays put while the query grows).
  useEffect(() => {
    if (query === "" || error) {
      engine.clearSearch();
      setResults(null);
      return;
    }
    engine.findNext(query, options);
  }, [engine, query, options, error]);

  const find = (direction: "next" | "previous") => {
    if (query === "" || error) return;
    if (direction === "next") engine.findNext(query, options);
    else engine.findPrevious(query, options);
  };

  useImperativeHandle(ref, () => ({
    focus: () => {
      input.current?.focus();
      input.current?.select();
    },
    find,
  }));

  const close = () => {
    engine.clearSearch();
    onClose();
  };

  const toggle = (key: keyof SearchOptions, label: string, icon: typeof Icons.CaseSensitive) => (
    <IconButton
      icon={icon}
      label={label}
      size="sm"
      aria-pressed={options[key]}
      className={cn(options[key] && "bg-surface-3 text-fg")}
      onClick={() => setOptions((current) => ({ ...current, [key]: !current[key] }))}
    />
  );

  return (
    <search
      className="absolute end-3 top-2 z-20 flex max-w-[calc(100%-1.5rem)] flex-col gap-1 rounded-lg border border-border bg-surface p-1.5 shadow-popover"
      aria-label={t("search.label")}
    >
      <div className="flex items-center gap-1">
        <Input
          ref={input}
          type="search"
          aria-label={t("search.label")}
          placeholder={t("search.placeholder")}
          value={query}
          invalid={error !== null}
          aria-describedby={error ? "terminal-search-error" : undefined}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              find(event.shiftKey ? "previous" : "next");
            } else if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              close();
            } else if (event.key === "F3") {
              event.preventDefault();
              find(event.shiftKey ? "previous" : "next");
            }
          }}
          className="h-7 w-52 min-w-0"
        />
        <span className="min-w-16 px-1 text-center text-sm text-muted tabular-nums" aria-live="polite">
          {resultText(query, results)}
        </span>
        {toggle("caseSensitive", t("search.caseSensitive"), Icons.CaseSensitive)}
        {toggle("wholeWord", t("search.wholeWord"), Icons.WholeWord)}
        {toggle("regex", t("search.regex"), Icons.Regex)}
        <IconButton
          icon={Icons.ChevronUp}
          label={t("action.terminal.findPrevious")}
          shortcut={primaryShortcut("terminal.findPrevious", platform)}
          size="sm"
          onClick={() => find("previous")}
        />
        <IconButton
          icon={Icons.ChevronDown}
          label={t("action.terminal.findNext")}
          shortcut={primaryShortcut("terminal.findNext", platform)}
          size="sm"
          onClick={() => find("next")}
        />
        <IconButton icon={Icons.X} label={t("search.close")} shortcut="Escape" size="sm" onClick={close} />
      </div>
      {error && (
        <p id="terminal-search-error" role="alert" className="px-1 text-sm text-danger">
          {t("search.invalidRegex", { message: error })}
        </p>
      )}
    </search>
  );
});
