// Errors of the agent commands, shaped like the backend's `AppError {code, message}`. The codes are the contract from
// brief 24; anything else maps to "unknown" so a new backend code still reaches the UI as a sentence.
export type AgentsErrorCode =
  | "agent.resume_unsupported"
  | "agent.unknown"
  | "agent.profile_invalid"
  | "agent.profile_not_found"
  | "agent.definition_invalid"
  | "agent.not_installed"
  | "agent.session_not_found"
  | "agent.definition_duplicate"
  | "agent.definition_in_use"
  | "agent.definition_not_found"
  | "task.not_found"
  | "hooks.unsupported"
  | "hooks.conflict"
  | "hooks.unparseable"
  | "unknown";

const CODES: ReadonlySet<string> = new Set([
  "agent.resume_unsupported",
  "agent.unknown",
  "agent.profile_invalid",
  "agent.profile_not_found",
  "agent.definition_invalid",
  "agent.not_installed",
  "agent.session_not_found",
  "agent.definition_duplicate",
  "agent.definition_in_use",
  "agent.definition_not_found",
  "task.not_found",
  "hooks.unsupported",
  "hooks.conflict",
  "hooks.unparseable",
]);

export class AgentsError extends Error {
  constructor(
    readonly code: AgentsErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "AgentsError";
  }
}

/** Maps whatever a command rejected with (an `AppError`-like object, an Error, a string) to an AgentsError. */
export function mapAgentsError(cause: unknown): AgentsError {
  if (cause instanceof AgentsError) return cause;
  const record = (typeof cause === "object" && cause !== null ? cause : {}) as Record<string, unknown>;
  const original =
    typeof record.cause === "object" && record.cause !== null ? (record.cause as Record<string, unknown>) : record;
  const code = typeof record.code === "string" ? record.code : typeof original.code === "string" ? original.code : "";
  const message =
    typeof record.message === "string"
      ? record.message
      : typeof original.message === "string"
        ? original.message
        : cause instanceof Error
          ? cause.message
          : String(cause);
  return new AgentsError(CODES.has(code) ? (code as AgentsErrorCode) : "unknown", message);
}

/** The sentence to show for a failed call (the backend's message is already a sentence). */
export function agentsErrorMessage(cause: unknown): string {
  return mapAgentsError(cause).message;
}
