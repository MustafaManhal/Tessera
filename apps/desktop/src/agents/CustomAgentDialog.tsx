// The custom-agent dialog (FR-34): name (id derived, editable), binaries, version command, prompt mode with a
// plain-language hint each, optional model flag / resume / skip-permissions flags / ready regex / URLs / icon,
// an explicit override consent for bundled ids, a Test button that only runs detection + the version command,
// and per-field inline errors. Save writes the definition through `agentDefinitionSave`.
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
  type StringKey,
} from "@tessera/ui";
import { useEffect, useState } from "react";
import { Field } from "../projects/dialogs/Field";
import { agentsErrorMessage } from "./errors";
import { agentsClient } from "./service";
import {
  deriveId,
  draftFromInput,
  emptyDraft,
  inputFromDraft,
  testArgs,
  validateDraft,
  type CustomAgentDraft,
  type DraftErrors,
  type PromptModeChoice,
} from "./customAgent";
import type { AgentDefinitionInput, AgentDefinitionTest } from "./types";

const ICONS = ["bot", "terminal", "code", "message-square", "zap", "moon", "sparkles", "git-branch"] as const;
const PROMPT_MODES: PromptModeChoice[] = ["arg", "stdin", "type"];

export function CustomAgentDialog({
  open,
  editId,
  bundledIds,
  onClose,
  onSaved,
}: {
  open: boolean;
  /** Set in edit mode: the dialog loads the stored definition itself. */
  editId: string | null;
  bundledIds: ReadonlySet<string>;
  onClose: () => void;
  onSaved: () => void;
}) {
  const client = agentsClient();
  const [draft, setDraft] = useState<CustomAgentDraft>(emptyDraft);
  const [errors, setErrors] = useState<DraftErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"load" | "test" | "save" | null>(null);
  const [test, setTest] = useState<AgentDefinitionTest | null>(null);
  const [testError, setTestError] = useState<string | null>(null);

  // Load once per open/edit; the name-derived id only applies to new agents.
  useEffect(() => {
    if (!open) return;
    setErrors({});
    setFormError(null);
    setTest(null);
    setTestError(null);
    if (editId === null) {
      setDraft(emptyDraft());
      return;
    }
    setBusy("load");
    client
      .agentDefinitionGet(editId)
      .then((input: AgentDefinitionInput) => setDraft(draftFromInput(input)))
      .catch((cause) => setFormError(agentsErrorMessage(cause)))
      .finally(() => setBusy(null));
  }, [open, editId, client]);

  const isBundledId = bundledIds.has(draft.id);
  const err = (key: keyof CustomAgentDraft) => (errors[key] ? t(errors[key] as StringKey) : null);
  const set = <K extends keyof CustomAgentDraft>(key: K, value: CustomAgentDraft[K]) => {
    setDraft((current) => ({ ...current, [key]: value }));
    setErrors((current) => ({ ...current, [key]: undefined }));
    setFormError(null);
  };

  const runTest = async () => {
    if (busy) return;
    setBusy("test");
    setTestError(null);
    try {
      const args = testArgs(draft);
      setTest(await client.agentDefinitionTest(args.binaries, args.versionCmd));
    } catch (cause) {
      setTest(null);
      setTestError(agentsErrorMessage(cause));
    } finally {
      setBusy(null);
    }
  };

  const save = async () => {
    if (busy) return;
    const found = validateDraft(draft, bundledIds);
    setErrors(found);
    if (Object.keys(found).length > 0) {
      setFormError(t("agents.custom.error.form"));
      return;
    }
    setBusy("save");
    setFormError(null);
    try {
      await client.agentDefinitionSave(inputFromDraft(draft));
      onSaved();
      onClose();
    } catch (cause) {
      setFormError(agentsErrorMessage(cause));
      setBusy(null);
    }
  };

  const title = editId ? t("agents.custom.title.edit", { name: draft.name || editId }) : t("agents.custom.title.new");

  return (
    <Dialog open={open} onOpenChange={(next) => !next && busy === null && onClose()}>
      <DialogContent data-custom-agent-dialog className="max-h-[85vh] overflow-y-auto sm:max-w-xl">
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription>{t("agents.custom.description")}</DialogDescription>

        <div className="flex flex-col gap-3">
          <Field label={t("agents.custom.field.name")} error={err("name")}>
            {({ id, describedBy }) => (
              <Input
                id={id}
                autoFocus
                value={draft.name}
                invalid={!!errors.name}
                aria-describedby={describedBy}
                onChange={(event) => {
                  const name = event.target.value;
                  setDraft((current) => ({
                    ...current,
                    name,
                    id: current.idEdited ? current.id : deriveId(name),
                  }));
                  setErrors((current) => ({ ...current, name: undefined }));
                }}
              />
            )}
          </Field>

          <Field label={t("agents.custom.field.id")} hint={t("agents.custom.field.idHint")} error={err("id")}>
            {({ id, describedBy }) => (
              <Input
                id={id}
                value={draft.id}
                invalid={!!errors.id}
                aria-describedby={describedBy}
                onChange={(event) => {
                  const id = event.target.value.toLowerCase();
                  setDraft((current) => ({ ...current, id, idEdited: true }));
                  setErrors((current) => ({ ...current, id: undefined }));
                  setFormError(null);
                }}
              />
            )}
          </Field>
          {isBundledId && (
            <div className="flex items-start gap-2 rounded-md bg-st-error-tint p-2 text-sm" data-bundled-id>
              <Icons.TriangleAlert size={16} className="mt-0.5 shrink-0 text-st-error" aria-hidden />
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <p>{t("agents.custom.override")}</p>
                <Switch
                  checked={draft.allowOverride}
                  onCheckedChange={(checked) => set("allowOverride", checked)}
                  aria-label={t("agents.custom.override")}
                />
              </div>
            </div>
          )}

          <Field
            label={t("agents.custom.field.binaries")}
            hint={t("agents.custom.field.binariesHint")}
            error={err("binariesText")}
          >
            {({ id, describedBy }) => (
              <Input
                id={id}
                value={draft.binariesText}
                invalid={!!errors.binariesText}
                aria-describedby={describedBy}
                placeholder="mycli, mycli-agent"
                onChange={(event) => set("binariesText", event.target.value)}
              />
            )}
          </Field>

          <Field
            label={t("agents.custom.field.versionCmd")}
            hint={t("agents.custom.field.versionCmdHint")}
            error={err("versionCmdText")}
          >
            {({ id, describedBy }) => (
              <Input
                id={id}
                value={draft.versionCmdText}
                invalid={!!errors.versionCmdText}
                aria-describedby={describedBy}
                onChange={(event) => set("versionCmdText", event.target.value)}
              />
            )}
          </Field>

          <Field label={t("agents.custom.field.promptMode")}>
            {({ describedBy }) => (
              <div className="flex flex-col gap-1">
                <Select
                  aria-label={t("agents.custom.field.promptMode")}
                  value={draft.promptMode}
                  onValueChange={(value) => set("promptMode", value as PromptModeChoice)}
                  options={PROMPT_MODES.map((mode) => ({
                    value: mode,
                    label: t(`agents.custom.promptMode.${mode}` as StringKey),
                  }))}
                />
                <p id={describedBy} className="text-xs text-muted">
                  {t(`agents.custom.promptMode.${draft.promptMode}Hint` as StringKey)}
                </p>
              </div>
            )}
          </Field>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field
              label={t("agents.custom.field.modelFlag")}
              hint={t("agents.custom.field.modelFlagHint")}
              error={err("modelFlag")}
            >
              {({ id, describedBy }) => (
                <Input
                  id={id}
                  value={draft.modelFlag}
                  aria-describedby={describedBy}
                  placeholder="--model"
                  onChange={(e) => set("modelFlag", e.target.value)}
                />
              )}
            </Field>
            <Field label={t("agents.custom.field.icon")}>
              {() => (
                <Select
                  aria-label={t("agents.custom.field.icon")}
                  value={draft.icon}
                  onValueChange={(value) => set("icon", value)}
                  options={ICONS.map((icon) => ({ value: icon, label: icon }))}
                />
              )}
            </Field>
          </div>

          <Field
            label={t("agents.custom.field.resume")}
            hint={t("agents.custom.field.resumeHint")}
            error={err("resumeText")}
          >
            {({ id, describedBy }) => (
              <Input
                id={id}
                value={draft.resumeText}
                invalid={!!errors.resumeText}
                aria-describedby={describedBy}
                placeholder="mycli --resume {external_session_id}"
                onChange={(event) => set("resumeText", event.target.value)}
              />
            )}
          </Field>

          <Field
            label={t("agents.custom.field.yoloFlags")}
            hint={t("agents.custom.field.yoloFlagsHint")}
            error={err("yoloFlagsText")}
          >
            {({ id, describedBy }) => (
              <Input
                id={id}
                value={draft.yoloFlagsText}
                aria-describedby={describedBy}
                placeholder="--yolo --skip-permissions"
                onChange={(event) => set("yoloFlagsText", event.target.value)}
              />
            )}
          </Field>

          <Field
            label={t("agents.custom.field.readyPattern")}
            hint={t("agents.custom.field.readyPatternHint")}
            error={err("readyPattern")}
          >
            {({ id, describedBy }) => (
              <Input
                id={id}
                value={draft.readyPattern}
                invalid={!!errors.readyPattern}
                aria-describedby={describedBy}
                placeholder="ready> $"
                onChange={(event) => set("readyPattern", event.target.value)}
              />
            )}
          </Field>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label={t("agents.custom.field.installUrl")}>
              {({ id }) => (
                <Input
                  id={id}
                  value={draft.installUrl}
                  placeholder={draft.binariesText.split(/[\s,]+/)[0] ?? ""}
                  onChange={(e) => set("installUrl", e.target.value)}
                />
              )}
            </Field>
            <Field label={t("agents.custom.field.docsUrl")}>
              {({ id }) => (
                <Input
                  id={id}
                  value={draft.docsUrl}
                  placeholder="https://"
                  onChange={(e) => set("docsUrl", e.target.value)}
                />
              )}
            </Field>
          </div>

          <div className="flex flex-wrap items-center gap-2 rounded-md border border-border p-2" data-definition-test>
            <Button
              size="sm"
              variant="ghost"
              icon={Icons.Play}
              loading={busy === "test"}
              onClick={() => void runTest()}
            >
              {busy === "test" ? t("agents.custom.testing") : t("agents.custom.test")}
            </Button>
            {test && (
              <span
                className={`text-sm ${test.found ? "text-fg" : "text-muted"}`}
                data-test-result={test.found ? "found" : "missing"}
              >
                {test.found
                  ? test.version
                    ? t("agents.custom.testFound", { path: test.binary_path ?? "", version: test.version })
                    : t("agents.custom.testFoundNoVersion", { path: test.binary_path ?? "" })
                  : t("agents.custom.testMissing")}
              </span>
            )}
            {testError && (
              <span role="alert" className="text-sm text-st-error">
                {t("agents.custom.testError", { message: testError })}
              </span>
            )}
          </div>

          {formError && (
            <p
              role="alert"
              data-form-error
              className="rounded-md border border-border bg-st-error-tint px-3 py-2 text-sm"
            >
              {formError}
            </p>
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" disabled={busy !== null} onClick={onClose}>
            {t("agents.custom.cancel")}
          </Button>
          <Button variant="primary" disabled={busy !== null || busy === "load"} onClick={() => void save()}>
            {busy === "save" ? t("agents.custom.saving") : t("agents.custom.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
