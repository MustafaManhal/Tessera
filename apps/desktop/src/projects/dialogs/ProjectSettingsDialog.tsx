// Project settings (S-17, FR-26, FR-28, FR-30): name, folder, base branch, worktree folder, files to copy or link, setup
// script with its shell and approval state, run scripts, port base, mute. The form is a draft saved with one button;
// every rule the backend enforces is checked here first (relative copy paths without `..`, ports, empty names), and
// backend refusals show next to the field they belong to. Run scripts save as you add, toggle and remove them.
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
  IconButton,
  Icons,
  Input,
  Select,
  StatusPill,
  Switch,
  t,
} from "@tessera/ui";
import { useEffect, useId, useMemo, useState } from "react";
import { notifications } from "../../notify";
import { useAppDispatch, useAppSelector } from "../../store/hooks";
import { announce } from "../../store/uiSlice";
import { mapProjectsError, type ProjectsError } from "../errors";
import { projectsClient } from "../service";
import { copyPathProblem } from "../slug";
import { addRunScript, approveSetup, loadRunScripts, removeRunScript, updateProject, updateRunScript } from "../thunks";
import type { CopyFile, Project, ProjectPatch, RunScript, SetupState } from "../types";
import { Field, FormError, errorText, TextArea } from "./Field";

const SHELLS = ["zsh", "bash", "sh", "fish", "pwsh", "powershell"] as const;
const PORT_MIN = 1024;
const PORT_MAX = 65_000;

/** Validation of a draft; each entry is a catalog sentence for the field. Empty object: valid. */
export interface DraftErrors {
  name?: string;
  baseBranch?: string;
  worktreeDir?: string;
  portBase?: string;
  /** By index of the copy row. */
  copy?: Record<number, string>;
}

export interface Draft {
  name: string;
  baseBranch: string;
  worktreeDir: string;
  copyFiles: CopyFile[];
  setupScript: string;
  setupShell: string;
  portBase: string;
  muted: boolean;
}

export function draftOf(project: Project): Draft {
  return {
    name: project.name,
    baseBranch: project.default_branch,
    worktreeDir: project.worktree_dir ?? "",
    copyFiles: project.copy_files.map((file) => ({ ...file })),
    setupScript: project.setup_script ?? "",
    setupShell: project.setup_shell ?? "zsh",
    portBase: project.port_base === null ? "" : String(project.port_base),
    muted: project.is_muted,
  };
}

const COPY_MESSAGES = {
  empty: "projectSettings.copyEmpty",
  absolute: "projectSettings.copyAbsolute",
  parent: "projectSettings.copyParent",
  drive: "projectSettings.copyDrive",
} as const;

export function validateDraft(draft: Draft): DraftErrors {
  const errors: DraftErrors = {};
  if (draft.name.trim() === "") errors.name = t("projectSettings.nameEmpty");
  if (draft.baseBranch.trim() === "") errors.baseBranch = t("projectSettings.branchEmpty");
  const dir = draft.worktreeDir.trim();
  if (dir !== "" && !/^([/\\]|[A-Za-z]:[/\\])/.test(dir)) errors.worktreeDir = t("projectSettings.worktreeDirAbsolute");
  const port = draft.portBase.trim();
  if (port !== "" && !(/^\d+$/.test(port) && Number(port) >= PORT_MIN && Number(port) <= PORT_MAX))
    errors.portBase = t("projectSettings.portInvalid");
  draft.copyFiles.forEach((file, index) => {
    const problem = copyPathProblem(file.path);
    if (problem) errors.copy = { ...errors.copy, [index]: t(COPY_MESSAGES[problem]) };
  });
  return errors;
}

export function hasErrors(errors: DraftErrors): boolean {
  return Object.keys(errors).length > 0;
}

export function patchOf(draft: Draft): ProjectPatch {
  const script = draft.setupScript.trim() === "" ? null : draft.setupScript;
  return {
    name: draft.name.trim(),
    default_branch: draft.baseBranch.trim(),
    worktree_dir: draft.worktreeDir.trim() === "" ? null : draft.worktreeDir.trim(),
    copy_files: draft.copyFiles.map((file) => ({ path: file.path.trim(), mode: file.mode })),
    setup_script: script,
    setup_shell: script === null ? null : draft.setupShell,
    port_base: draft.portBase.trim() === "" ? null : Number(draft.portBase),
    is_muted: draft.muted,
  };
}

export function ProjectSettingsDialog({ projectId, onClose }: { projectId: string; onClose: () => void }) {
  const project = useAppSelector((state) => state.projects.projects[projectId]);
  if (!project) return null;
  return <Body project={project} onClose={onClose} />;
}

function Body({ project, onClose }: { project: Project; onClose: () => void }) {
  const dispatch = useAppDispatch();
  const scripts = useAppSelector((state) => state.projects.scripts[project.id]) ?? [];
  const [draft, setDraft] = useState(() => draftOf(project));
  const [errors, setErrors] = useState<DraftErrors>({});
  const [failure, setFailure] = useState<ProjectsError | null>(null);
  const [busy, setBusy] = useState(false);
  const [branches, setBranches] = useState<string[]>([]);
  const [newScript, setNewScript] = useState({ name: "", command: "" });
  const [scriptError, setScriptError] = useState<string | null>(null);
  const listId = useId();

  useEffect(() => {
    void dispatch(loadRunScripts(project.id)).catch(() => {});
    void projectsClient()
      .repoInfo(project.path)
      .then((facts) =>
        setBranches([
          ...new Set([facts.default_branch, facts.branch, project.default_branch].filter((b): b is string => !!b)),
        ]),
      )
      .catch(() => setBranches([project.default_branch]));
  }, [dispatch, project.id, project.path, project.default_branch]);

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => {
    setDraft((current) => ({ ...current, [key]: value }));
    setErrors((current) => ({ ...current, [key]: undefined, ...(key === "copyFiles" ? { copy: undefined } : {}) }));
    setFailure(null);
  };

  const dirty = useMemo(() => JSON.stringify(draft) !== JSON.stringify(draftOf(project)), [draft, project]);

  const save = async () => {
    const found = validateDraft(draft);
    setErrors(found);
    if (hasErrors(found)) return;
    setBusy(true);
    setFailure(null);
    try {
      await dispatch(updateProject(project.id, patchOf(draft)));
      dispatch(announce(t("projectSettings.saved")));
      notifications().toastNow({ title: t("projectSettings.saved") });
      onClose();
    } catch (cause) {
      const error = mapProjectsError(cause);
      if (error.kind === "InvalidCopyFile") setErrors({ ...found, copy: { 0: errorText(error) } });
      setFailure(error);
      setBusy(false);
    }
  };

  const approve = async () => {
    try {
      await dispatch(approveSetup(project.id));
      dispatch(announce(t("projectSettings.approved")));
    } catch (cause) {
      setFailure(mapProjectsError(cause));
    }
  };

  const addScript = async () => {
    if (newScript.name.trim() === "" || newScript.command.trim() === "") {
      setScriptError(t("projectSettings.runNeedsBoth"));
      return;
    }
    try {
      await dispatch(
        addRunScript(project.id, { name: newScript.name.trim(), command: newScript.command.trim(), auto_start: false }),
      );
      setNewScript({ name: "", command: "" });
      setScriptError(null);
    } catch (cause) {
      setScriptError(errorText(mapProjectsError(cause)));
    }
  };

  const scriptDirty =
    draft.setupScript !== (project.setup_script ?? "") ||
    (draft.setupScript.trim() !== "" && draft.setupShell !== (project.setup_shell ?? "zsh"));
  const setupState: SetupState = project.setup_state;

  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent
        className="max-h-[calc(100vh-4rem)] max-w-2xl overflow-y-auto"
        aria-describedby="project-settings-description"
      >
        <DialogTitle>{t("projectSettings.title")}</DialogTitle>
        <DialogDescription id="project-settings-description" className="sr-only">
          {project.name}
        </DialogDescription>
        <div className="grid gap-x-4 sm:grid-cols-2">
          <Field label={t("projectSettings.name")} error={errors.name ?? null}>
            {({ id, describedBy }) => (
              <Input
                id={id}
                autoFocus
                value={draft.name}
                invalid={!!errors.name}
                aria-describedby={describedBy}
                onChange={(event) => set("name", event.target.value)}
              />
            )}
          </Field>
          <Field label={t("projectSettings.path")}>
            {({ id }) => <Input id={id} value={project.path} readOnly className="font-mono text-sm" />}
          </Field>
          <Field
            label={t("projectSettings.baseBranch")}
            hint={t("projectSettings.baseBranchHint")}
            error={errors.baseBranch ?? null}
          >
            {({ id, describedBy }) => (
              <>
                <Input
                  id={id}
                  list={listId}
                  value={draft.baseBranch}
                  invalid={!!errors.baseBranch}
                  aria-describedby={describedBy}
                  spellCheck={false}
                  onChange={(event) => set("baseBranch", event.target.value)}
                />
                <datalist id={listId}>
                  {branches.map((branch) => (
                    <option key={branch} value={branch} />
                  ))}
                </datalist>
              </>
            )}
          </Field>
          <Field
            label={t("projectSettings.worktreeDir")}
            hint={t("projectSettings.worktreeDirHint")}
            error={errors.worktreeDir ?? null}
          >
            {({ id, describedBy }) => (
              <Input
                id={id}
                value={draft.worktreeDir}
                invalid={!!errors.worktreeDir}
                aria-describedby={describedBy}
                spellCheck={false}
                onChange={(event) => set("worktreeDir", event.target.value)}
              />
            )}
          </Field>
        </div>

        <fieldset className="flex flex-col gap-2 border-0 p-0">
          <legend className="text-sm font-medium">{t("projectSettings.copyFiles")}</legend>
          <p className="text-xs text-muted">{t("projectSettings.copyFilesHint")}</p>
          {draft.copyFiles.map((file, index) => (
            // The rows have no id of their own; their order is their identity while editing.
            // biome-ignore lint/suspicious/noArrayIndexKey: rows are edited in place.
            <div key={index} className="flex items-start gap-2" data-copy-row={index}>
              <div className="min-w-0 flex-1">
                <Input
                  aria-label={`${t("projectSettings.copyPath")} ${index + 1}`}
                  value={file.path}
                  invalid={!!errors.copy?.[index]}
                  spellCheck={false}
                  onChange={(event) =>
                    set(
                      "copyFiles",
                      draft.copyFiles.map((entry, i) => (i === index ? { ...entry, path: event.target.value } : entry)),
                    )
                  }
                />
                {errors.copy?.[index] && (
                  <p role="alert" className="pt-1 text-xs text-danger">
                    {errors.copy[index]}
                  </p>
                )}
              </div>
              <div className="w-28 shrink-0">
                <Select
                  aria-label={`${t("projectSettings.copyMode")} ${index + 1}`}
                  value={file.mode}
                  options={[
                    { value: "copy", label: t("projectSettings.copyModeCopy") },
                    { value: "symlink", label: t("projectSettings.copyModeSymlink") },
                  ]}
                  onValueChange={(mode) =>
                    set(
                      "copyFiles",
                      draft.copyFiles.map((entry, i) =>
                        i === index ? { ...entry, mode: mode as CopyFile["mode"] } : entry,
                      ),
                    )
                  }
                />
              </div>
              <IconButton
                icon={Icons.X}
                size="sm"
                className="mt-1"
                label={t("projectSettings.removeCopy", { path: file.path || String(index + 1) })}
                onClick={() =>
                  set(
                    "copyFiles",
                    draft.copyFiles.filter((_, i) => i !== index),
                  )
                }
              />
            </div>
          ))}
          <div>
            <Button
              size="sm"
              icon={Icons.Plus}
              onClick={() => set("copyFiles", [...draft.copyFiles, { path: "", mode: "copy" }])}
            >
              {t("projectSettings.addCopy")}
            </Button>
          </div>
        </fieldset>

        <fieldset className="flex flex-col gap-2 border-0 p-0">
          <legend className="flex items-center gap-2 text-sm font-medium">
            {t("projectSettings.setup")}
            <StatusPill
              status={setupState === "approved" ? "done" : setupState === "needs_approval" ? "needs" : "off"}
              label={t(`projectSettings.setupState.${setupState}`)}
            />
          </legend>
          <p className="text-xs text-muted">{t("projectSettings.setupHint")}</p>
          <div className="flex items-center gap-2">
            <span className="text-sm">{t("projectSettings.setupShell")}</span>
            <div className="w-36">
              <Select
                aria-label={t("projectSettings.setupShell")}
                value={draft.setupShell}
                options={SHELLS.map((shell) => ({ value: shell, label: shell }))}
                onValueChange={(shell) => set("setupShell", shell)}
              />
            </div>
          </div>
          <TextArea
            aria-label={t("projectSettings.setup")}
            value={draft.setupScript}
            spellCheck={false}
            className="font-mono text-sm"
            onChange={(event) => set("setupScript", event.target.value)}
          />
          {setupState === "needs_approval" && (
            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" icon={Icons.ShieldCheck} disabled={scriptDirty} onClick={() => void approve()}>
                {t("projectSettings.approve")}
              </Button>
              {scriptDirty && <span className="text-xs text-muted">{t("projectSettings.approveSaveFirst")}</span>}
            </div>
          )}
        </fieldset>

        <fieldset className="flex flex-col gap-2 border-0 p-0">
          <legend className="text-sm font-medium">{t("projectSettings.runScripts")}</legend>
          <p className="text-xs text-muted">{t("projectSettings.runScriptsHint")}</p>
          {scripts.length === 0 && <p className="text-sm text-muted">{t("projectSettings.runNone")}</p>}
          {scripts.map((script: RunScript) => (
            <div key={script.id} className="flex items-center gap-2" data-run-script={script.name}>
              <span className="w-24 shrink-0 truncate text-sm font-medium">{script.name}</span>
              <code className="min-w-0 flex-1 truncate rounded-sm bg-surface-2 px-1.5 py-1 font-mono text-sm">
                {script.command}
              </code>
              <Switch
                aria-label={`${t("projectSettings.runAuto")}: ${script.name}`}
                checked={script.auto_start}
                onCheckedChange={(checked) =>
                  void dispatch(updateRunScript(project.id, script.id, { auto_start: checked }))
                }
              />
              <IconButton
                icon={Icons.X}
                size="sm"
                label={t("projectSettings.runRemove", { name: script.name })}
                onClick={() => void dispatch(removeRunScript(project.id, script.id))}
              />
            </div>
          ))}
          <div className="flex items-start gap-2">
            <Input
              aria-label={t("projectSettings.runNameLabel")}
              placeholder={t("projectSettings.runName")}
              className="w-28 shrink-0"
              value={newScript.name}
              onChange={(event) => setNewScript({ ...newScript, name: event.target.value })}
            />
            <Input
              aria-label={t("projectSettings.runCommandLabel")}
              placeholder={t("projectSettings.runCommand")}
              value={newScript.command}
              spellCheck={false}
              onChange={(event) => setNewScript({ ...newScript, command: event.target.value })}
            />
            <Button icon={Icons.Plus} onClick={() => void addScript()}>
              {t("projectSettings.runAdd")}
            </Button>
          </div>
          {scriptError && (
            <p role="alert" className="text-xs text-danger">
              {scriptError}
            </p>
          )}
        </fieldset>

        <div className="grid gap-x-4 sm:grid-cols-2">
          <Field
            label={t("projectSettings.portBase")}
            hint={t("projectSettings.portBaseHint")}
            error={errors.portBase ?? null}
          >
            {({ id, describedBy }) => (
              <Input
                id={id}
                inputMode="numeric"
                value={draft.portBase}
                invalid={!!errors.portBase}
                aria-describedby={describedBy}
                onChange={(event) => set("portBase", event.target.value)}
              />
            )}
          </Field>
          <div className="flex items-center gap-2 pt-6">
            <Switch id="project-mute" checked={draft.muted} onCheckedChange={(checked) => set("muted", checked)} />
            <label htmlFor="project-mute" className="text-base">
              {t("projectSettings.mute")}
            </label>
          </div>
        </div>

        <FormError message={hasErrors(errors) ? t("form.fixErrors") : failure ? errorText(failure) : null} />
        <DialogFooter>
          <Button onClick={onClose}>{t("form.cancel")}</Button>
          <Button variant="primary" disabled={busy || !dirty} onClick={() => void save()}>
            {busy ? t("form.saving") : t("form.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
