// biome-ignore-all lint/a11y/noStaticElementInteractions: the panel only forwards the arrow, Enter and Esc keys of its search box.
// biome-ignore-all lint/a11y/noNoninteractiveElementToInteractiveRole: the results are an ARIA listbox of options on a list (APG combobox pattern).
// The issue picker of the New task dialog (M9.1, FR-54, FR-55): GitHub issues of the project's repository or Linear
// issues, searchable, keyboard driven (arrows move, Enter picks, Esc closes). Errors explain what to connect.
import { Button, Input, t } from "@tessera/ui";
import { useEffect, useId, useRef, useState } from "react";
import { issuesClient } from "./service";
import type { Issue, IssueProvider } from "./types";

type State =
  | { kind: "loading" }
  | { kind: "ready"; issues: Issue[] }
  | { kind: "error"; message: string; code: string };

export function IssuePicker({
  projectId,
  initialQuery,
  onPick,
  onClose,
}: {
  projectId: string;
  initialQuery: string;
  onPick: (issue: Issue) => void;
  onClose: () => void;
}) {
  const [provider, setProvider] = useState<IssueProvider>("github");
  const [query, setQuery] = useState(initialQuery);
  const [state, setState] = useState<State>({ kind: "loading" });
  const [active, setActive] = useState(0);
  const listId = useId();
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => input.current?.focus(), []);
  useEffect(() => {
    let alive = true;
    setState({ kind: "loading" });
    const timer = setTimeout(() => {
      issuesClient()
        .issuesList(projectId, provider, query.trim() === "" ? null : query)
        .then((issues) => {
          if (!alive) return;
          setState({ kind: "ready", issues });
          setActive(0);
        })
        .catch((cause: Error & { code?: string }) => {
          if (alive) setState({ kind: "error", message: cause.message, code: cause.code ?? "" });
        });
    }, 200);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [projectId, provider, query]);

  const issues = state.kind === "ready" ? state.issues : [];
  const onKey = (event: React.KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onClose();
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (issues.length === 0) return;
      setActive((index) => (index + (event.key === "ArrowDown" ? 1 : -1) + issues.length) % issues.length);
    } else if (event.key === "Enter") {
      // Enter in the search box picks; it must not submit or create the task.
      event.preventDefault();
      event.stopPropagation();
      const chosen = issues[active];
      if (chosen) onPick(chosen);
    }
  };

  return (
    <div
      className="flex flex-col gap-2 rounded-md border border-border bg-surface-2 p-2"
      data-issue-picker
      onKeyDown={onKey}
    >
      <div className="flex flex-wrap items-center gap-2">
        {(["github", "linear"] as const).map((item) => (
          <Button
            key={item}
            size="sm"
            variant={provider === item ? "primary" : "secondary"}
            aria-pressed={provider === item}
            data-issue-provider={item}
            onClick={() => setProvider(item)}
          >
            {item === "github" ? "GitHub" : "Linear"}
          </Button>
        ))}
        <div className="min-w-32 flex-1">
          <Input
            ref={input}
            aria-label={t("issues.search")}
            placeholder={t("issues.search")}
            role="combobox"
            aria-expanded
            aria-controls={listId}
            aria-activedescendant={issues[active] ? `${listId}-${active}` : undefined}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        <Button size="sm" variant="ghost" onClick={onClose}>
          {t("button.cancel")}
        </Button>
      </div>
      {state.kind === "loading" && (
        <p className="m-0 text-sm text-muted" role="status">
          {t("issues.loading")}
        </p>
      )}
      {state.kind === "error" && (
        <p className="m-0 text-sm text-danger" role="alert" data-issue-error={state.code}>
          {state.code === "github.not_connected"
            ? t("issues.connectGithub")
            : state.code === "linear.not_connected"
              ? t("issues.connectLinear")
              : state.message}
        </p>
      )}
      {state.kind === "ready" && issues.length === 0 && (
        <p className="m-0 text-sm text-muted" role="status">
          {t("issues.none")}
        </p>
      )}
      {issues.length > 0 && (
        <ul
          id={listId}
          role="listbox"
          aria-label={t("issues.results")}
          className="m-0 max-h-52 list-none overflow-auto p-0"
        >
          {issues.map((issue, index) => (
            <li
              key={issue.id}
              id={`${listId}-${index}`}
              role="option"
              aria-selected={index === active}
              data-issue-option={issue.key}
              tabIndex={-1}
              onMouseEnter={() => setActive(index)}
              onClick={() => onPick(issue)}
              onKeyDown={() => {}}
              className={`flex cursor-pointer items-baseline gap-2 rounded-sm px-2 py-1 ${index === active ? "bg-surface-3" : ""}`}
            >
              <span className="shrink-0 font-mono text-xs text-muted">{issue.key}</span>
              <span className="min-w-0 flex-1 truncate text-sm">{issue.title}</span>
              {issue.labels.slice(0, 2).map((label) => (
                <span key={label} className="shrink-0 rounded-sm bg-surface-3 px-1 text-xs text-muted">
                  {label}
                </span>
              ))}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
