// Panes that came back from a saved layout (M3.4), whose scrollback is loaded before the new shell starts.
import type { PaneId } from "../layout";

const restored = new Set<PaneId>();

export function markRestored(ids: Iterable<PaneId>): void {
  for (const id of ids) restored.add(id);
}

/** True once for a pane that was restored; later starts of the same pane (Restart) get false. */
export function consumeRestored(paneId: PaneId): boolean {
  return restored.delete(paneId);
}

/**
 * Sent after a session that kept running in the session daemon is re-attached and its output replayed. The program
 * that switched mouse or focus reporting on may be gone (it was stopped with the app), so the shell that is left
 * would print every mouse move as text. A program that is still running switches them on again when it redraws.
 */
export const REPORTING_RESET =
  "\x1b[?9l\x1b[?1000l\x1b[?1001l\x1b[?1002l\x1b[?1003l\x1b[?1004l\x1b[?1005l\x1b[?1006l\x1b[?1015l\x1b[?1016l";

/**
 * Sent right after the saved history of a restored pane is replayed. The history can end in the middle of a program
 * that had switched on mouse reporting, focus reports, the alternate screen or a hidden cursor (an agent's interface,
 * for example). Replaying those switches into the fresh terminal makes it send mouse moves to the new shell, which
 * prints them as text, so every one is switched off again. Bracketed paste is left alone: the new shell sets it itself.
 */
export const MODE_RESET =
  "\x1b[?9l\x1b[?1000l\x1b[?1001l\x1b[?1002l\x1b[?1003l\x1b[?1004l\x1b[?1005l\x1b[?1006l\x1b[?1015l\x1b[?1016l" +
  "\x1b[?47l\x1b[?1047l\x1b[?1049l\x1b[?25h\x1b[?1l\x1b>\x1b[0m";
