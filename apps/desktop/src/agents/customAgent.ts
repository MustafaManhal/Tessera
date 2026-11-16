// The custom-agent dialog's draft state and validation (FR-34), kept pure so unit tests cover the rules the
// backend enforces in `definition.rs`: id charset, required fields, prompt modes, regex, and the bundled-id
// override consent.
import { parseArgs } from "./args";
import type { AgentDefinitionInput } from "./types";

export type PromptModeChoice = "arg" | "stdin" | "type";

export interface CustomAgentDraft {
  name: string;
  id: string;
  /** True once the user edited the id by hand; the name stops deriving it. */
  idEdited: boolean;
  binariesText: string;
  versionCmdText: string;
  promptMode: PromptModeChoice;
  modelFlag: string;
  resumeText: string;
  yoloFlagsText: string;
  readyPattern: string;
  installUrl: string;
  docsUrl: string;
  icon: string;
  allowOverride: boolean;
}

export type DraftErrors = Partial<Record<keyof CustomAgentDraft | "form", string>>;

/** Lower-case letters, digits and dashes — the same rule `valid_id` applies in Rust. */
export const ID_PATTERN = /^[a-z0-9-]{1,64}$/;

/** "My Agent CLI" → "my-agent-cli"; the id stays editable afterwards. */
export function deriveId(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

export function emptyDraft(): CustomAgentDraft {
  return {
    name: "",
    id: "",
    idEdited: false,
    binariesText: "",
    versionCmdText: "",
    promptMode: "arg",
    modelFlag: "",
    resumeText: "",
    yoloFlagsText: "",
    readyPattern: "",
    installUrl: "",
    docsUrl: "",
    icon: "bot",
    allowOverride: false,
  };
}

export function draftFromInput(input: AgentDefinitionInput): CustomAgentDraft {
  return {
    name: input.name,
    id: input.id,
    idEdited: true,
    binariesText: input.binaries.join(", "),
    versionCmdText: input.version_cmd.join(" "),
    promptMode: (["arg", "stdin", "type"].includes(input.prompt_mode) ? input.prompt_mode : "arg") as PromptModeChoice,
    modelFlag: input.model_flag ?? "",
    resumeText: input.resume.join(" "),
    yoloFlagsText: input.yolo_flags.join(" "),
    readyPattern: input.ready_pattern ?? "",
    installUrl: input.install_url,
    docsUrl: input.docs_url,
    icon: input.icon || "bot",
    allowOverride: false,
  };
}

/** Comma- or whitespace-separated binary names, trimmed and deduplicated. */
export function parseBinaries(text: string): string[] {
  return [
    ...new Set(
      text
        .split(/[\s,]+/)
        .map((part) => part.trim())
        .filter(Boolean),
    ),
  ];
}

function parseFlags(text: string): string[] {
  return text.split(/\s+/).filter(Boolean);
}

/** Validates the draft into per-field errors; an empty object means the draft can be saved. */
export function validateDraft(draft: CustomAgentDraft, bundledIds: ReadonlySet<string>): DraftErrors {
  const errors: DraftErrors = {};
  if (draft.name.trim() === "") errors.name = "agents.custom.error.name";
  if (!ID_PATTERN.test(draft.id)) errors.id = "agents.custom.error.id";
  else if (bundledIds.has(draft.id) && !draft.allowOverride) errors.id = "agents.custom.error.bundled";
  if (parseBinaries(draft.binariesText).length === 0) errors.binariesText = "agents.custom.error.binaries";
  const version = parseArgs(draft.versionCmdText);
  if (version.error !== null || version.args.length === 0) errors.versionCmdText = "agents.custom.error.versionCmd";
  if (draft.readyPattern.trim() !== "") {
    try {
      new RegExp(draft.readyPattern);
    } catch {
      errors.readyPattern = "agents.custom.error.readyPattern";
    }
  }
  if (draft.resumeText.trim() !== "") {
    const resume = parseArgs(draft.resumeText);
    // The first word is the executable; the rest are args that may only use {external_session_id}.
    const badTemplate = resume.args.slice(1).some((arg) => /[{}]/.test(arg.replaceAll("{external_session_id}", "")));
    if (resume.error !== null || resume.args.length === 0) errors.resumeText = "agents.custom.error.resume";
    else if (badTemplate) errors.resumeText = "agents.custom.error.resumeTemplate";
  }
  return errors;
}

/** The save payload; blanks get the same defaults the backend documents (binary name, "https://"). */
export function inputFromDraft(draft: CustomAgentDraft): AgentDefinitionInput {
  const binaries = parseBinaries(draft.binariesText);
  const version = parseArgs(draft.versionCmdText);
  const resume = parseArgs(draft.resumeText);
  return {
    id: draft.id.trim(),
    name: draft.name.trim(),
    binaries,
    version_cmd: version.args,
    prompt_mode: draft.promptMode,
    model_flag: draft.modelFlag.trim() || null,
    resume: resume.args,
    yolo_flags: parseFlags(draft.yoloFlagsText),
    hooks: "none",
    ready_pattern: draft.readyPattern.trim() || null,
    install_url: draft.installUrl.trim() || binaries[0] || draft.name.trim(),
    docs_url: draft.docsUrl.trim() || "https://",
    icon: draft.icon || "bot",
    allow_override: draft.allowOverride,
  };
}

/** Arguments for the Test button: the entered binaries and the parsed version command. */
export function testArgs(draft: CustomAgentDraft): { binaries: string[]; versionCmd: string[] } {
  return { binaries: parseBinaries(draft.binariesText), versionCmd: parseArgs(draft.versionCmdText).args };
}
