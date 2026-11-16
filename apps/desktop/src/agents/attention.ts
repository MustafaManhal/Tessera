// Agent sessions → attention signals (brief 32, TRD §4.6): a session moving to needs_input, or to idle after
// working, marks its pane for attention when the user is not looking at it — after a 2 s debounce so a quick
// working→idle→working never pings. The mark drives the pane ring, tab dot, sidebar badge and the dock/taskbar
// count; the OS notification and the inbox row respect DND, per-project mute and the notifications settings.
import type { AgentSession } from "./types";

/** Debounce per session (TRD: 2 s, so flickering statuses don't ping). */
export const ATTENTION_DEBOUNCE_MS = 2_000;

export type AttentionKind = "needs_input" | "done";

/** The transition that asks for attention, or null. `before` is the status the session had a moment ago. */
export function attentionKind(
  status: AgentSession["status"],
  before: AgentSession["status"] | undefined,
): AttentionKind | null {
  if (status === "needs_input") return "needs_input";
  // "Done": the agent went quiet after actually working — not from starting/idle churn.
  if (status === "idle" && before === "working") return "done";
  return null;
}

/** Which config switch a kind answers to (`notifications.agent-needs-input` / `agent-done`). */
export function attentionConfigKey(kind: AttentionKind): "agent-needs-input" | "agent-done" {
  return kind === "needs_input" ? "agent-needs-input" : "agent-done";
}

/** DND: `notifications.dnd-until` is a Unix timestamp (seconds); 0 or past means off. */
export function isDndActive(dndUntil: unknown, nowSeconds: number): boolean {
  return typeof dndUntil === "number" && dndUntil > nowSeconds;
}

/** The config value for a dotted key (`notifications.dnd-until`) out of the settings `config.values` object. */
export function configValue(config: unknown, key: string): unknown {
  let node = config;
  for (const part of key.split(".")) {
    if (node === null || typeof node !== "object") return undefined;
    node = (node as Record<string, unknown>)[part];
  }
  return node;
}
