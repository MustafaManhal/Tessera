// New task (S-04, FR-27, FR-29, FR-35): project, optional name with the generated slug and branch shown live, a prompt
// stored with the task, agent chips (each chosen profile starts in the new worktree with the prompt), base branch,
// "use the main checkout" with its
// warning, "run the setup script". Create shows progress and keeps backend errors (BranchExists, WorktreeFailed) inline.
// `Cmd/Ctrl+Enter` creates. On success the task's tab opens, with the setup approval pane when the script needs it.
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
  Icons,
  Input,
  Select,
  Switch,
  t,
} from "@tessera/ui";
import { useEffect, useId, useMemo, useState } from "react";
import { agentsErrorMessage } from "../../agents/errors";
import { IssuePicker } from "../../issues/IssuePicker";
import { hashTrigger, issuePrompt, issueTaskName } from "../../issues/prompt";
import { issuesClient } from "../../issues/service";
import type { Issue } from "../../issues/types";
import { TaskAgentSelect } from "../../agents/TaskAgentSelect";
import { startAgent } from "../../agents/launch";
import { useLaunchable } from "../../agents/useLaunchable";
import { notifications } from "../../notify";
import { openTaskTab } from "../../sidebar/taskTabs";
import { useAppDispatch, useAppSelector } from "../../store/hooks";
import { selectProjectList } from "../../store/projectsSlice";
import { announce, setSettingsOpen, setSettingsPage } from "../../store/uiSlice";
import { mapProjectsError, type ProjectsError } from "../errors";
import { projectsClient } from "../service";
import { branchFor, slugify } from "../slug";
import { createTask } from "../thunks";
import { useCheckouts } from "../useCheckouts";
import { Field, FormError, errorText, TextArea } from "./Field";

export const NAME_MAX = 80;
const NEW_BRANCH = "__new__";

/** The name the preview slug comes from: the typed name, else the first words of the prompt. */
export function previewName(name: string, prompt: string): string {
  const typed = name.trim();
  if (typed !== "") return typed;
  return prompt.trim().split(/\s+/).slice(0, 6).join(" ");
}

export function NewTaskDialog({
  projectId,
  prompt: initialPrompt,
  onClose,
}: {
  projectId: string | null;
  prompt?: string;
  onClose: () => void;
}) {
  const dispatch = useAppDispatch();
  const projects = useAppSelector(selectProjectList);
  const prefix = "tessera/";
  const [chosen, setChosen] = useState<string>(
    projectId && projects.some((p) => p.id === projectId) ? projectId : (projects[0]?.id ?? ""),
  );
  const project = projects.find((candidate) => candidate.id === chosen);
  const [name, setName] = useState("");
  const [prompt, setPrompt] = useState(initialPrompt ?? "");
  // The issue this task is for (M9.1): picked from the picker, which `#` in the prompt also opens.
  const [issue, setIssue] = useState<Issue | null>(null);
  const [picker, setPicker] = useState<{ query: string; start: number | null } | null>(null);
  const [base, setBase] = useState(project?.default_branch ?? "main");
  const [main, setMain] = useState(false);
  const [runSetup, setRunSetup] = useState(true);
  const [branches, setBranches] = useState<string[]>([]);
  // "" creates a new tessera/ branch; a name checks out that existing local branch instead.
  const [existing, setExisting] = useState("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<ProjectsError | null>(null);
  const [errors, setErrors] = useState<{ name?: string; base?: string }>({});
  const { items: launchable } = useLaunchable();
  const [agentChoice, setAgentChoice] = useState<string[]>([]);
  const toggleAgent = (profileId: string) =>
    setAgentChoice((chosen) =>
      chosen.includes(profileId) ? chosen.filter((id) => id !== profileId) : [...chosen, profileId],
    );
  const mainId = useId();
  const setupId = useId();

  // The base branch follows the project until the user types their own.
  const [baseTouched, setBaseTouched] = useState(false);
  useEffect(() => {
    if (!baseTouched && project) setBase(project.default_branch);
  }, [project, baseTouched]);
  useEffect(() => {
    if (!project) return;
    void projectsClient()
      .repoInfo(project.path)
      .then(async (facts) => {
        const known = [facts.default_branch, facts.branch, project.default_branch].filter((b): b is string => !!b);
        const listed = await projectsClient()
          .gitBranches(project.path)
          .catch(() => [] as string[]);
        setBranches([...new Set([...known, ...listed])]);
      })
      .catch(() => setBranches([project.default_branch]));
  }, [project]);

  const remote = (entry: string) => entry.startsWith("remotes/");
  const localBranches = branches.filter((entry) => !remote(entry));
  const baseOptions = [...new Set([base, ...branches].map((entry) => entry.replace(/^remotes\//, "")))].map(
    (entry) => ({ value: entry, label: entry }),
  );
  const checkouts = useCheckouts(project);
  // The chosen branch may already be checked out: then the task works in that folder and no worktree is created.
  const taken = existing ? checkouts?.find((entry) => entry.branch === existing) : undefined;
  const takenIsMain = !!taken && !!project && taken.path.replace(/[\\/]+$/, "") === project.path.replace(/[\\/]+$/, "");
  // Branch mode: the task is a branch of the project folder, so there is no worktree to name, share or set up.
  const branchMode = project?.work_mode === "branches";
  const slug = useMemo(() => slugify(previewName(name, prompt)), [name, prompt]);
  const branch = main && !branchMode ? null : existing || branchFor(slug, prefix);
  const hasSetup = (project?.setup_state ?? "none") !== "none";

  const create = async () => {
    const found: { name?: string; base?: string } = {};
    if (name.trim().length > NAME_MAX) found.name = t("newTask.nameLong");
    if (base.trim() === "") found.base = t("projectSettings.branchEmpty");
    setErrors(found);
    if (!project || found.name || found.base) return;
    setBusy(true);
    setFailure(null);
    try {
      const result = await dispatch(
        createTask({
          project_id: project.id,
          ...(name.trim()
            ? { name: name.trim() }
            : issue
              ? { name: issueTaskName(issue) }
              : prompt.trim()
                ? { name: previewName("", prompt) }
                : {}),
          ...(prompt.trim() ? { prompt } : {}),
          base_branch: base.trim(),
          ...(existing && !main ? { existing_branch: existing } : {}),
          agents: [],
          use_main_checkout: main,
          run_setup: runSetup && !main && !branchMode,
        }),
      );
      const created = result.tasks[0];
      if (created && issue) {
        // The link back to the issue is best effort: the task exists either way.
        await issuesClient()
          .taskSetIssue(created.id, issue)
          .catch(() => {});
      }
      if (created) {
        dispatch(announce(t("newTask.created", { name: created.name })));
        notifications().toastNow({ title: t("newTask.created", { name: created.name }) });
        onClose();
        dispatch(openTaskTab(created.id, result.setup));
        // Agents start after the task tab exists, so each opens as a pane beside the task's terminal.
        for (const profileId of agentChoice) {
          try {
            await dispatch(
              startAgent({ profileId, prompt: prompt.trim() ? prompt : null, taskId: created.id, cwd: null }),
            );
          } catch (cause) {
            notifications().toastNow({
              kind: "error",
              title: t("agents.launch.failed", { message: agentsErrorMessage(cause) }),
            });
          }
        }
      } else onClose();
    } catch (cause) {
      setFailure(mapProjectsError(cause));
      setBusy(false);
    }
  };

  const nameError =
    errors.name ?? (failure?.kind === "BranchExists" ? t("newTask.branchExists", { branch: branch ?? "" }) : null);

  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent
        className="max-h-[calc(100vh-4rem)] max-w-xl overflow-y-auto"
        aria-describedby="new-task-description"
        // Esc closes the issue picker first (it handles the key itself); a second Esc closes the dialog.
        onEscapeKeyDown={(event) => {
          if (picker) event.preventDefault();
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && !busy) {
            event.preventDefault();
            void create();
          }
        }}
      >
        <DialogTitle>{t("newTask.title")}</DialogTitle>
        <DialogDescription id="new-task-description">
          {t(branchMode ? "newTask.descriptionBranches" : "newTask.description")}
        </DialogDescription>
        {projects.length === 0 ? (
          <p className="text-muted">{t("newTask.noProjects")}</p>
        ) : (
          <>
            <Field label={t("newTask.project")}>
              {({ id }) => (
                <Select
                  id={id}
                  value={chosen}
                  options={projects.map((candidate) => ({ value: candidate.id, label: candidate.name }))}
                  onValueChange={(value) => {
                    setChosen(value);
                    setBaseTouched(false);
                  }}
                />
              )}
            </Field>
            <Field label={t("newTask.name")} hint={t("newTask.nameHint")} error={nameError}>
              {({ id, describedBy }) => (
                <Input
                  id={id}
                  autoFocus
                  value={name}
                  invalid={!!nameError}
                  aria-describedby={describedBy}
                  onChange={(event) => {
                    setName(event.target.value);
                    setErrors((current) => ({ ...current, name: undefined }));
                    setFailure(null);
                  }}
                />
              )}
            </Field>
            <p className="-mt-2 text-xs text-muted" data-branch-preview aria-live="polite">
              {main && !branchMode
                ? t("newTask.mainCheckoutWarning")
                : existing || slug
                  ? t("newTask.branchPreview", { branch: branch ?? "" })
                  : t("newTask.branchAuto")}
            </p>
            <Field label={t("newTask.prompt")} hint={t("newTask.promptHint")}>
              {({ id, describedBy }) => (
                <TextArea
                  id={id}
                  aria-describedby={describedBy}
                  value={prompt}
                  onChange={(event) => {
                    setPrompt(event.target.value);
                    const found = hashTrigger(
                      event.target.value,
                      event.target.selectionStart ?? event.target.value.length,
                    );
                    if (found) setPicker(found);
                    else if (picker?.start != null) setPicker(null);
                  }}
                />
              )}
            </Field>
            <div className="-mt-2 flex flex-wrap items-center gap-2" data-issue-row>
              {issue ? (
                <span
                  data-issue-chip={issue.key}
                  className="inline-flex max-w-full items-center gap-1 rounded-sm bg-surface-3 px-1.5 py-0.5 text-xs"
                >
                  <span className="shrink-0 font-mono">{t("issues.chip", { key: issue.key })}</span>
                  <span className="min-w-0 truncate text-muted">{issue.title}</span>
                  <button
                    type="button"
                    aria-label={t("issues.remove")}
                    className="shrink-0 cursor-pointer border-0 bg-transparent p-0 text-muted"
                    onClick={() => setIssue(null)}
                  >
                    <Icons.X size={12} aria-hidden />
                  </button>
                </span>
              ) : (
                <Button size="sm" variant="ghost" data-issue-pick onClick={() => setPicker({ query: "", start: null })}>
                  {t("issues.pick")}
                </Button>
              )}
              <span className="text-xs text-muted">{t("issues.hint")}</span>
            </div>
            {picker && project && (
              <IssuePicker
                projectId={project.id}
                initialQuery={picker.query}
                onClose={() => setPicker(null)}
                onPick={(picked) => {
                  setIssue(picked);
                  // The typed "#query" goes away; the issue becomes the prompt unless the user wrote more.
                  const rest =
                    picker.start == null
                      ? prompt
                      : (prompt.slice(0, picker.start) + prompt.slice(picker.start + 1 + picker.query.length)).trim();
                  setPrompt(rest === "" ? issuePrompt(picked) : `${rest}\n\n${issuePrompt(picked)}`);
                  setPicker(null);
                }}
              />
            )}
            <fieldset className="flex flex-col gap-1 border-0 p-0" aria-describedby="agents-hint">
              <legend className="text-sm font-medium">{t("newTask.agents")}</legend>
              <TaskAgentSelect
                items={launchable}
                chosen={agentChoice}
                onToggle={toggleAgent}
                onManage={() => {
                  onClose();
                  dispatch(setSettingsPage("agents"));
                  dispatch(setSettingsOpen(true));
                }}
              />
              <p id="agents-hint" className="text-xs text-muted">
                {launchable.length > 0 ? t("newTask.agentsHint") : t("newTask.agentsNone")}
              </p>
            </fieldset>
            {!main && (
              <Field label={t("newTask.branchMode")}>
                {({ id, describedBy }) => (
                  <Select
                    id={id}
                    value={existing || NEW_BRANCH}
                    aria-describedby={describedBy}
                    options={[
                      { value: NEW_BRANCH, label: t("newTask.branchNew") },
                      ...localBranches.map((entry) => ({
                        value: entry,
                        label: t("newTask.branchUse", { branch: entry }),
                      })),
                    ]}
                    onValueChange={(next) => setExisting(next === NEW_BRANCH ? "" : next)}
                  />
                )}
              </Field>
            )}
            {taken && !main && !branchMode && (
              <p
                role="status"
                data-branch-taken
                className="-mt-2 flex items-start gap-1.5 rounded-lg border border-st-needs/50 bg-st-needs-tint p-2 text-sm"
              >
                <Icons.TriangleAlert size={14} className="mt-0.5 shrink-0 text-st-needs" aria-hidden />
                <span>
                  {takenIsMain
                    ? t("newTask.branchTakenMain", { branch: existing })
                    : t("newTask.branchTaken", { branch: existing, path: taken.path })}
                </span>
              </p>
            )}
            {(main || !existing) && (
              <Field label={t("newTask.baseBranch")} error={errors.base ?? null}>
                {({ id, describedBy }) => (
                  <Select
                    id={id}
                    value={base}
                    invalid={!!errors.base}
                    aria-describedby={describedBy}
                    options={baseOptions}
                    onValueChange={(next) => {
                      setBase(next);
                      setBaseTouched(true);
                      setErrors((current) => ({ ...current, base: undefined }));
                    }}
                  />
                )}
              </Field>
            )}
            <div className="flex flex-col gap-2">
              {branchMode ? (
                <p role="note" data-branch-mode className="text-xs text-muted">
                  {t("newTask.branchModeNote")}
                </p>
              ) : (
                <div className="flex items-center gap-2">
                  <Switch id={mainId} checked={main} onCheckedChange={setMain} />
                  <label htmlFor={mainId} className="text-base">
                    {t("newTask.mainCheckout")}
                  </label>
                </div>
              )}
              {main && !branchMode && (
                <p
                  role="note"
                  className="flex items-start gap-2 rounded-md border border-border bg-st-needs-tint px-3 py-2 text-sm"
                >
                  <Icons.TriangleAlert size={16} className="mt-0.5 shrink-0 text-st-needs" aria-hidden />
                  {t("newTask.mainCheckoutWarning")}
                </p>
              )}
              <div className="flex items-center gap-2">
                <Switch
                  id={setupId}
                  checked={runSetup && !main && !branchMode && hasSetup}
                  disabled={main || branchMode || !hasSetup}
                  onCheckedChange={setRunSetup}
                />
                <label htmlFor={setupId} className="text-base">
                  {t("newTask.runSetup")}
                </label>
                {(main || !hasSetup) && (
                  <span className="text-xs text-muted">
                    {t(main ? "newTask.runSetupMain" : "newTask.runSetupNone")}
                  </span>
                )}
              </div>
            </div>
            <FormError message={failure && failure.kind !== "BranchExists" ? errorText(failure) : null} />
          </>
        )}
        <DialogFooter>
          <Button onClick={onClose} disabled={busy}>
            {t("form.cancel")}
          </Button>
          <Button
            variant="primary"
            icon={busy ? Icons.LoaderCircle : Icons.Plus}
            disabled={busy || !project}
            onClick={() => void create()}
          >
            {busy ? t("newTask.creating") : t("newTask.create")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
