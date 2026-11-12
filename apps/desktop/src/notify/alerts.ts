// Long-command alert (FR-18): when a command block ends after more than `terminal.long_command_seconds` while you are
// not looking at its pane (another tab or pane, or another app), say so. Pure: the caller passes the times.
import { type Block, blockDuration, formatDuration } from "@tessera/term";
import { t } from "@tessera/ui";
import type { BadgeKind } from "../store/attentionSlice";

export interface AlertInput {
  block: Pick<Block, "id" | "command" | "startedAt" | "endedAt" | "exitCode" | "status">;
  /** `terminal.long_command_alert`. */
  enabled: boolean;
  thresholdSeconds: number;
  /** The pane is the focused pane of the active tab, on screen. */
  paneFocused: boolean;
  windowFocused: boolean;
  /** Blocks already alerted for (never twice). */
  alerted: ReadonlySet<number>;
}

export interface Alert {
  body: string;
  badge: BadgeKind;
}

/**
 * The alert for a finished block, or null. Rules: the switch is on; the block finished (success or failure, not
 * aborted); it ran longer than the threshold, measured from its start (C) to its end (D) on the injected clock, so a
 * block that began while the window was already unfocused still needs the full threshold; the pane or the window is
 * not focused when it ends; and it was not alerted before.
 */
export function longCommandAlert(input: AlertInput): Alert | null {
  const { block } = input;
  if (!input.enabled || input.alerted.has(block.id)) return null;
  if (block.status !== "success" && block.status !== "failure") return null;
  const duration = blockDuration(block);
  if (duration === null || duration <= input.thresholdSeconds * 1000) return null;
  if (input.paneFocused && input.windowFocused) return null;
  const command = block.command ?? t("alert.unnamed");
  return {
    body: t("alert.finished", {
      command: command.length > 60 ? `${command.slice(0, 59)}…` : command.replace(/\s*\n\s*/g, " "),
      duration: formatDuration(duration),
      code: block.exitCode ?? 0,
    }),
    badge: block.status === "failure" ? "failed" : "finished",
  };
}
