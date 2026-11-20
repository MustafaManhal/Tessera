// One profile's editor (S-05): name, model, extra arguments with a live argv preview, environment rows, and the
// skip-permissions switch with its red warning (FR-42). Edits save a moment after they are valid (like the settings
// form); Save flushes at once. The command preview comes from the backend so the flags shown are the real ones, and
// it carries env names only, never values.
import { Button, cn, Icons, IconButton, Input, Switch, t } from "@tessera/ui";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { isValidEnvKey, joinArgs, parseArgs } from "./args";
import type { AgentsClient } from "./client";
import { agentsErrorMessage } from "./errors";
import type { AgentInfo, AgentProfile, AgentProfileInput, CommandPreview } from "./types";

interface EnvRow {
  /** Stable across edits, so an input keeps focus when an earlier row is removed. */
  id: number;
  key: string;
  value: string;
}

interface Draft {
  name: string;
  model: string;
  args: string;
  env: EnvRow[];
  skip: boolean;
}

// Only needs to be unique within a draft.
let nextEnvRow = 1;

function draftOf(profile: AgentProfile): Draft {
  return {
    name: profile.name,
    model: profile.model ?? "",
    args: joinArgs(profile.extra_args),
    env: Object.entries(profile.env).map(([key, value]) => ({ id: nextEnvRow++, key, value })),
    skip: profile.skip_permissions,
  };
}

function inputOf(draft: Draft, profile: AgentProfile): AgentProfileInput {
  const env: Record<string, string> = {};
  for (const row of draft.env) if (row.key !== "") env[row.key] = row.value;
  return {
    id: profile.id,
    agent_id: profile.agent_id,
    name: draft.name.trim(),
    model: draft.model.trim() || null,
    extra_args: parseArgs(draft.args).args,
    env,
    skip_permissions: draft.skip,
    is_default: profile.is_default,
  };
}

/** A row with a name but no value still counts; a row where both are empty is just a placeholder. */
function envProblem(draft: Draft): number {
  return draft.env.findIndex((row) => (row.key !== "" || row.value !== "") && !isValidEnvKey(row.key));
}

export interface ProfileEditorProps {
  agent: AgentInfo;
  profile: AgentProfile;
  client: AgentsClient;
  onSave: (input: AgentProfileInput) => Promise<AgentProfile>;
  onDone: () => void;
}

export function ProfileEditor({ agent, profile, client, onSave, onDone }: ProfileEditorProps) {
  const [draft, setDraft] = useState<Draft>(() => draftOf(profile));
  const [touched, setTouched] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [status, setStatus] = useState<"idle" | "saving" | "saved">("idle");
  const [preview, setPreview] = useState<CommandPreview | null>(null);
  const saved = useRef(JSON.stringify(inputOf(draftOf(profile), profile)));
  const inFlight = useRef(false);
  const root = useRef<HTMLDivElement>(null);

  const parsed = useMemo(() => parseArgs(draft.args), [draft.args]);
  const nameProblem = draft.name.trim() === "";
  const badEnv = envProblem(draft);
  // Chips for the parsed argv; a repeated argument still needs a unique key.
  const seenArgs = new Map<string, number>();
  const argChips = parsed.args.map((arg) => {
    const count = (seenArgs.get(arg) ?? 0) + 1;
    seenArgs.set(arg, count);
    return { id: `${arg}\u0000${count}`, arg };
  });

  useEffect(() => {
    // The name field first, selected, so typing replaces "New profile" or the old name.
    const input = root.current?.querySelector<HTMLInputElement>("input[data-agent-name]");
    input?.focus();
    input?.select();
  }, []);

  const persist = useCallback(
    async (value: Draft): Promise<boolean> => {
      const args = parseArgs(value.args);
      if (value.name.trim() === "" || args.error !== null || envProblem(value) >= 0) return false;
      const input = inputOf(value, profile);
      const serialised = JSON.stringify(input);
      if (serialised === saved.current) return true;
      inFlight.current = true;
      setStatus("saving");
      try {
        await onSave(input);
        saved.current = serialised;
        setStatus("saved");
        setSaveError(null);
        // The preview shows the stored profile, so refetch it now (the effect above covers the first open).
        void client.agentCommandPreview(profile.id, null).then(setPreview, () => setPreview(null));
        return true;
      } catch (cause) {
        setStatus("idle");
        setSaveError(agentsErrorMessage(cause));
        return false;
      } finally {
        inFlight.current = false;
      }
    },
    [client, onSave, profile],
  );

  // The command preview comes from the backend (the real flags), debounced and refetched after every save.
  const refreshPreview = useCallback(async (): Promise<void> => {
    try {
      setPreview(await client.agentCommandPreview(profile.id, null));
    } catch {
      setPreview(null);
    }
  }, [client, profile.id]);

  useEffect(() => {
    const timer = setTimeout(() => void refreshPreview(), 200);
    return () => clearTimeout(timer);
  }, [refreshPreview]);

  // Live save: a valid change is written shortly after typing stops (the settings screen does the same).
  useEffect(() => {
    const timer = setTimeout(() => {
      if (!inFlight.current) void persist(draft);
    }, 400);
    return () => clearTimeout(timer);
  }, [draft, persist]);

  const update = (patch: Partial<Draft>) => {
    setDraft((current) => ({ ...current, ...patch }));
    setStatus("idle");
  };

  const saveNow = () => {
    setTouched(true);
    void persist(draft);
  };

  const envUnsupported = badEnv >= 0 && touched;

  return (
    <div
      ref={root}
      data-profile-form
      className="mt-2 flex flex-col gap-3 rounded-lg border border-border-strong bg-surface p-3"
    >
      <div className="flex items-start gap-2">
        <h5 className="min-w-0 flex-1 text-base font-semibold">{t("agents.edit")}</h5>
        <span role="status" aria-live="polite" className="text-sm text-muted" data-profile-status>
          {status === "saving" ? t("agents.profile.saving") : status === "saved" ? t("agents.profile.saved") : ""}
        </span>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="grid gap-1">
          <label className="grid gap-1" htmlFor={`${profile.id}-name`}>
            <span className="text-sm font-medium">{t("agents.profile.name")}</span>
            <Input
              id={`${profile.id}-name`}
              data-agent-name
              value={draft.name}
              invalid={nameProblem && touched}
              aria-describedby={nameProblem && touched ? `${profile.id}-name-error` : undefined}
              onChange={(event) => update({ name: event.target.value })}
              onBlur={() => setTouched(true)}
            />
          </label>
          {nameProblem && touched && (
            <span id={`${profile.id}-name-error`} role="alert" className="text-sm text-danger">
              {t("agents.profile.invalidName")}
            </span>
          )}
        </div>
        <div className="grid gap-1">
          <label className="grid gap-1" htmlFor={`${profile.id}-model`}>
            <span className="text-sm font-medium">{t("agents.profile.model")}</span>
            <Input
              id={`${profile.id}-model`}
              value={draft.model}
              aria-describedby={`${profile.id}-model-hint`}
              onChange={(event) => update({ model: event.target.value })}
            />
          </label>
          <span id={`${profile.id}-model-hint`} className="text-xs text-muted">
            {t("agents.profile.modelHint")}
          </span>
        </div>
      </div>

      <div className="grid gap-1">
        <label className="grid gap-1" htmlFor={`${profile.id}-args`}>
          <span className="text-sm font-medium">{t("agents.profile.args")}</span>
          <Input
            id={`${profile.id}-args`}
            value={draft.args}
            invalid={parsed.error !== null}
            aria-describedby={parsed.error ? `${profile.id}-args-error` : `${profile.id}-args-hint`}
            onChange={(event) => update({ args: event.target.value })}
            onBlur={() => setTouched(true)}
          />
        </label>
        {parsed.error ? (
          <span id={`${profile.id}-args-error`} role="alert" className="text-sm text-danger">
            {t(parsed.error === "unterminated" ? "agents.profile.argsUnterminated" : "agents.profile.argsEscape")}
          </span>
        ) : (
          <span id={`${profile.id}-args-hint`} className="text-xs text-muted">
            {t("agents.profile.argsHint")}
          </span>
        )}
        <div className="flex flex-wrap items-center gap-1" data-args-chips>
          <span className="text-xs text-muted">
            {parsed.args.length === 0 ? t("agents.profile.argsNone") : t("agents.profile.argsPassed")}
          </span>
          {argChips.map((chip) => (
            <code key={chip.id} className="rounded-sm bg-surface-2 px-1 text-xs text-fg" title={chip.arg}>
              {chip.arg}
            </code>
          ))}
        </div>
      </div>

      <div className="grid gap-2">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="text-sm font-medium">{t("agents.profile.env")}</span>
          <span className="ms-auto text-xs text-muted">{t("agents.profile.envNote")}</span>
        </div>
        {draft.env.length === 0 && <p className="text-sm text-muted">{t("agents.profile.previewNoEnv")}</p>}
        {draft.env.map((row, index) => (
          <div key={row.id} className="grid grid-cols-[1fr_1fr_auto] items-start gap-1">
            <Input
              aria-label={`${t("agents.profile.envKey")} ${index + 1}`}
              placeholder={t("agents.profile.envKey")}
              value={row.key}
              invalid={index === badEnv && touched}
              aria-describedby={index === badEnv && touched ? `${profile.id}-env-error` : undefined}
              onChange={(event) =>
                update({
                  env: draft.env.map((item, at) => (at === index ? { ...item, key: event.target.value } : item)),
                })
              }
              onBlur={() => setTouched(true)}
            />
            <Input
              aria-label={`${t("agents.profile.envValue")} ${index + 1}`}
              placeholder={t("agents.profile.envValue")}
              value={row.value}
              onChange={(event) =>
                update({
                  env: draft.env.map((item, at) => (at === index ? { ...item, value: event.target.value } : item)),
                })
              }
            />
            <IconButton
              size="sm"
              icon={Icons.X}
              label={t("agents.profile.removeEnv", { name: row.key || index + 1 })}
              onClick={() => update({ env: draft.env.filter((_, at) => at !== index) })}
            />
          </div>
        ))}
        {envUnsupported && (
          <span id={`${profile.id}-env-error`} role="alert" className="text-sm text-danger">
            {t("agents.profile.envKeyInvalid")}
          </span>
        )}
        <div>
          <Button
            size="sm"
            variant="ghost"
            icon={Icons.Plus}
            onClick={() => update({ env: [...draft.env, { id: nextEnvRow++, key: "", value: "" }] })}
          >
            {t("agents.profile.addEnv")}
          </Button>
        </div>
      </div>

      {agent.has_skip_permissions && (
        <div className="grid gap-1">
          <div className="flex items-center gap-2">
            <Switch
              id={`${profile.id}-skip`}
              checked={draft.skip}
              onCheckedChange={(checked) => update({ skip: checked })}
            />
            <label htmlFor={`${profile.id}-skip`} className="text-sm font-medium">
              {t("agents.profile.skip")}
            </label>
          </div>
          {draft.skip && (
            <p role="alert" data-skip-warning className="text-sm text-danger">
              {t("agents.profile.skipWarning")}
            </p>
          )}
        </div>
      )}

      <div className="grid gap-1" data-command-preview>
        <span className="text-sm font-medium">{t("agents.profile.preview")}</span>
        <code
          className={cn(
            "block rounded-md bg-surface-2 px-2 py-1 font-mono text-sm text-fg",
            "whitespace-pre-wrap break-all",
          )}
          title={preview ? [preview.program, ...preview.args].join(" ") : undefined}
        >
          {preview ? [preview.program, ...preview.args].join(" ") : "—"}
        </code>
        <span className="text-xs text-muted">
          {preview && preview.env_keys.length > 0
            ? t("agents.profile.previewEnv", { keys: preview.env_keys.join(", ") })
            : t("agents.profile.previewNoEnv")}
        </span>
      </div>

      {saveError && (
        <p role="alert" className="text-sm text-danger">
          {t("agents.profile.saveFailed", { message: saveError })}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="primary" icon={Icons.Check} onClick={saveNow}>
          {t("agents.profile.save")}
        </Button>
        <Button size="sm" onClick={onDone}>
          {t("agents.profile.done")}
        </Button>
      </div>
    </div>
  );
}
