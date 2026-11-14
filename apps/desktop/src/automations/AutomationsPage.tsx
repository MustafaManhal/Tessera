// S-20 Automations (M9.5, FR-61): a prompt that starts an agent in a new task of a project, on a schedule (cron, local
// time) or when a GitHub issue gets a label. The list shows trigger, next run and the last result; each row can be
// switched off, run now, edited, deleted (in-app confirmation) and opened to see its history, including runs that were
// missed because Tessera was closed.
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
  EmptyState,
  Icons,
  Input,
  Select,
  Switch,
  t,
} from "@tessera/ui";
import { type FormEvent, useCallback, useEffect, useId, useState } from "react";
import { launchableLabel, useLaunchable } from "../agents/useLaunchable";
import { Field, FormError, TextArea } from "../projects/dialogs/Field";
import { useAppSelector } from "../store/hooks";
import { selectProjectList } from "../store/projectsSlice";
import { describeCron, untilText } from "./schedule";
import { automationsClient } from "./service";
import type { Automation, AutomationRun, Trigger } from "./types";

const message = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

const PRESETS: { label: string; expr: string }[] = [
  { label: "Every hour", expr: "0 * * * *" },
  { label: "Every day at 09:00", expr: "0 9 * * *" },
  { label: "Weekdays at 09:00", expr: "0 9 * * 1-5" },
  { label: "Sundays at 22:00", expr: "0 22 * * 0" },
];

function triggerText(trigger: Trigger): string {
  return trigger.type === "cron"
    ? describeCron(trigger.expr)
    : t("automations.labelTrigger", { label: trigger.label, repo: trigger.repo });
}

function nextText(automation: Automation, now: number): string {
  if (!automation.is_enabled) return t("automations.off");
  if (automation.trigger.type === "label") return t("automations.watching");
  return automation.next_run_at === null
    ? "—"
    : t("automations.next", { when: untilText(automation.next_run_at, now) });
}

function when(at: number): string {
  return new Date(at * 1000).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function RunLine({ run }: { run: AutomationRun }) {
  const label =
    run.status === "ok"
      ? t("automations.run.ok")
      : run.status === "missed"
        ? t("automations.run.missed")
        : t("automations.run.failed");
  return (
    <li data-automation-run={run.status} className="flex flex-wrap items-baseline gap-2 text-sm">
      <span className={run.status === "ok" ? "text-fg" : run.status === "failed" ? "text-danger" : "text-warn"}>
        {label}
      </span>
      <span className="text-xs text-muted">{when(run.at)}</span>
      <span className="min-w-0 flex-1 text-xs text-muted">{run.message}</span>
    </li>
  );
}

export function AutomationsPage() {
  const projects = useAppSelector(selectProjectList);
  const [rows, setRows] = useState<Automation[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Automation | "new" | null>(null);
  const [removing, setRemoving] = useState<Automation | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [history, setHistory] = useState<AutomationRun[]>([]);
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));

  const reload = useCallback(async () => {
    try {
      setRows(await automationsClient().list());
      setError(null);
    } catch (cause) {
      setError(message(cause));
    }
  }, []);
  useEffect(() => {
    void reload();
    const stop = automationsClient().onChanged(() => void reload());
    const timer = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 30_000);
    return () => {
      stop();
      clearInterval(timer);
    };
  }, [reload]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `rows` re-reads the history when a run changed the list.
  useEffect(() => {
    if (!open) return;
    void automationsClient()
      .runs(open)
      .then(setHistory)
      .catch(() => setHistory([]));
  }, [open, rows]);

  const toggle = async (automation: Automation, enabled: boolean) => {
    try {
      await automationsClient().save({
        id: automation.id,
        project_id: automation.project_id,
        name: automation.name,
        profile_id: automation.profile_id,
        prompt: automation.prompt,
        trigger: automation.trigger,
        is_enabled: enabled,
      });
    } catch (cause) {
      setError(message(cause));
    }
  };
  const runNow = async (automation: Automation) => {
    try {
      await automationsClient().runNow(automation.id);
    } catch (cause) {
      setError(message(cause));
    }
  };
  const remove = async (automation: Automation) => {
    setRemoving(null);
    try {
      await automationsClient().remove(automation.id);
    } catch (cause) {
      setError(message(cause));
    }
  };

  const projectName = (id: string) => projects.find((p) => p.id === id)?.name ?? "";

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-6 pt-2" data-automations-page>
      <p className="text-sm text-muted">{t("automations.explain")}</p>
      <div className="flex items-center gap-2 py-2">
        <Button
          size="sm"
          variant="primary"
          icon={Icons.Plus}
          disabled={projects.length === 0}
          onClick={() => setEditing("new")}
        >
          {t("automations.new")}
        </Button>
        {projects.length === 0 && <span className="text-xs text-muted">{t("reason.noProjects")}</span>}
      </div>
      <FormError message={error} />
      {rows === null ? (
        <p className="text-muted" role="status">
          {t("settings.loading")}
        </p>
      ) : rows.length === 0 ? (
        <EmptyState icon={Icons.Clock} message={t("automations.empty")} />
      ) : (
        <ul className="m-0 flex list-none flex-col gap-2 p-0">
          {rows.map((automation) => (
            <li
              key={automation.id}
              data-automation={automation.name}
              className="flex flex-col gap-1 rounded-md border border-border bg-surface-2 p-3"
            >
              <div className="flex flex-wrap items-center gap-2">
                <Switch
                  aria-label={t("automations.enable", { name: automation.name })}
                  checked={automation.is_enabled}
                  onCheckedChange={(checked) => void toggle(automation, checked)}
                />
                <span className="text-sm font-medium">{automation.name}</span>
                <span className="text-xs text-muted">{projectName(automation.project_id)}</span>
                <div className="flex-1" />
                <Button size="sm" variant="ghost" data-automation-run-now onClick={() => void runNow(automation)}>
                  {t("automations.runNow")}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setEditing(automation)}>
                  {t("automations.edit")}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setRemoving(automation)}>
                  {t("automations.delete")}
                </Button>
              </div>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
                <span data-automation-trigger>{triggerText(automation.trigger)}</span>
                <span data-automation-next>{nextText(automation, now)}</span>
                <span data-automation-last>
                  {automation.last_run
                    ? t("automations.last", {
                        status: t(`automations.run.${automation.last_run.status}` as "automations.run.ok"),
                        when: when(automation.last_run.at),
                      })
                    : t("automations.neverRun")}
                </span>
                <button
                  type="button"
                  data-automation-history
                  aria-expanded={open === automation.id}
                  className="cursor-pointer border-0 bg-transparent p-0 text-xs text-accent-ink underline"
                  onClick={() => setOpen(open === automation.id ? null : automation.id)}
                >
                  {t("automations.history")}
                </button>
              </div>
              {open === automation.id && (
                <ul className="m-0 flex list-none flex-col gap-1 border-t border-border p-0 pt-2" data-automation-runs>
                  {history.length === 0 ? (
                    <li className="text-xs text-muted">{t("automations.noRuns")}</li>
                  ) : (
                    history.map((run) => <RunLine key={run.id} run={run} />)
                  )}
                </ul>
              )}
            </li>
          ))}
        </ul>
      )}
      {editing && (
        <AutomationEditor
          automation={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void reload();
          }}
        />
      )}
      <Dialog open={removing !== null} onOpenChange={(next) => !next && setRemoving(null)}>
        <DialogContent className="w-96" role="alertdialog">
          <DialogTitle>{t("automations.deleteTitle", { name: removing?.name ?? "" })}</DialogTitle>
          <DialogDescription>{t("automations.deleteBody")}</DialogDescription>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setRemoving(null)}>
              {t("button.cancel")}
            </Button>
            <Button variant="danger" onClick={() => removing && void remove(removing)}>
              {t("automations.delete")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function AutomationEditor({
  automation,
  onClose,
  onSaved,
}: {
  automation: Automation | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const projects = useAppSelector(selectProjectList);
  const { items: launchable } = useLaunchable();
  const [name, setName] = useState(automation?.name ?? "");
  const [projectId, setProjectId] = useState(automation?.project_id ?? projects[0]?.id ?? "");
  const [profileId, setProfileId] = useState(automation?.profile_id ?? "");
  const [prompt, setPrompt] = useState(automation?.prompt ?? "");
  const [kind, setKind] = useState<"cron" | "label">(automation?.trigger.type ?? "cron");
  const [expr, setExpr] = useState(automation?.trigger.type === "cron" ? automation.trigger.expr : "0 9 * * 1-5");
  const [repo, setRepo] = useState(automation?.trigger.type === "label" ? automation.trigger.repo : "");
  const [label, setLabel] = useState(automation?.trigger.type === "label" ? automation.trigger.label : "");
  const [enabled, setEnabled] = useState(automation?.is_enabled ?? true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const enabledId = useId();

  useEffect(() => {
    if (!profileId && launchable[0]) setProfileId(launchable[0].profile.id);
  }, [profileId, launchable]);

  const profileOptions = launchable.map((item) => ({ value: item.profile.id, label: launchableLabel(item) }));
  if (profileId && !profileOptions.some((o) => o.value === profileId))
    profileOptions.push({ value: profileId, label: t("automations.profileGone") });

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await automationsClient().save({
        id: automation?.id ?? null,
        project_id: projectId,
        name,
        profile_id: profileId,
        prompt,
        trigger:
          kind === "cron"
            ? { type: "cron", expr: expr.trim() }
            : { type: "label", repo: repo.trim(), label: label.trim() },
        is_enabled: enabled,
      });
      onSaved();
    } catch (cause) {
      setError(message(cause));
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(next) => !next && !busy && onClose()}>
      <DialogContent className="max-h-[calc(100vh-4rem)] max-w-xl overflow-y-auto" data-automation-editor>
        <DialogTitle>{automation ? t("automations.editTitle") : t("automations.newTitle")}</DialogTitle>
        <DialogDescription>{t("automations.editorBody")}</DialogDescription>
        <form className="flex flex-col gap-3" onSubmit={(event) => void submit(event)}>
          <Field label={t("automations.name")}>
            {({ id, describedBy }) => (
              <Input
                id={id}
                aria-describedby={describedBy}
                autoFocus
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            )}
          </Field>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label={t("automations.project")}>
              {({ id }) => (
                <Select
                  id={id}
                  value={projectId}
                  onValueChange={setProjectId}
                  options={projects.map((p) => ({ value: p.id, label: p.name }))}
                />
              )}
            </Field>
            <Field label={t("automations.profile")} error={launchable.length === 0 ? t("handoff.noAgent") : null}>
              {({ id }) => <Select id={id} value={profileId} onValueChange={setProfileId} options={profileOptions} />}
            </Field>
          </div>
          <Field label={t("automations.prompt")} hint={t("automations.promptHint")}>
            {({ id, describedBy }) => (
              <TextArea
                id={id}
                aria-describedby={describedBy}
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
              />
            )}
          </Field>
          <Field label={t("automations.trigger")}>
            {({ id }) => (
              <Select
                id={id}
                value={kind}
                onValueChange={(value) => setKind(value as "cron" | "label")}
                options={[
                  { value: "cron", label: t("automations.kind.cron") },
                  { value: "label", label: t("automations.kind.label") },
                ]}
              />
            )}
          </Field>
          {kind === "cron" ? (
            <div className="flex flex-col gap-2">
              <Field
                label={t("automations.schedule")}
                hint={`${describeCron(expr)} · ${t("automations.scheduleHint")}`}
              >
                {({ id, describedBy }) => (
                  <Input
                    id={id}
                    aria-describedby={describedBy}
                    className="font-mono"
                    spellCheck={false}
                    value={expr}
                    onChange={(e) => setExpr(e.target.value)}
                  />
                )}
              </Field>
              <div className="flex flex-wrap gap-1" data-cron-presets>
                {PRESETS.map((preset) => (
                  <Button key={preset.expr} size="sm" variant="secondary" onClick={() => setExpr(preset.expr)}>
                    {preset.label}
                  </Button>
                ))}
              </div>
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field label={t("automations.repo")} hint={t("automations.repoHint")}>
                {({ id, describedBy }) => (
                  <Input
                    id={id}
                    aria-describedby={describedBy}
                    placeholder="owner/name"
                    value={repo}
                    onChange={(e) => setRepo(e.target.value)}
                  />
                )}
              </Field>
              <Field label={t("automations.label")} hint={t("automations.labelHint")}>
                {({ id, describedBy }) => (
                  <Input
                    id={id}
                    aria-describedby={describedBy}
                    value={label}
                    onChange={(e) => setLabel(e.target.value)}
                  />
                )}
              </Field>
            </div>
          )}
          <div className="flex items-center gap-2">
            <Switch id={enabledId} checked={enabled} onCheckedChange={setEnabled} />
            <label htmlFor={enabledId} className="text-base">
              {t("automations.enabled")}
            </label>
          </div>
          <FormError message={error} />
          <DialogFooter>
            <Button variant="ghost" disabled={busy} onClick={onClose}>
              {t("button.cancel")}
            </Button>
            <Button variant="primary" type="submit" disabled={busy || profileId === ""}>
              {t("automations.save")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
