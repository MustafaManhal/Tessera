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
