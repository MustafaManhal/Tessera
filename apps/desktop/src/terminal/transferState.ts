import type { PaneId } from "../layout";

type Ready = (paneId: PaneId, ok: boolean) => void;
export const transferReadiness = new Map<string, Ready>();

const attaching = new Map<string, Set<Promise<void>>>();

export function trackTransferAttach(id: string, operation: Promise<void>): Promise<void> {
  const pending = attaching.get(id) ?? new Set<Promise<void>>();
  attaching.set(id, pending);
  pending.add(operation);
  return operation.finally(() => {
    pending.delete(operation);
    if (pending.size === 0) attaching.delete(id);
  });
}

export async function drainTransferAttaches(id: string): Promise<void> {
  await Promise.allSettled(attaching.get(id) ?? []);
}

// Marks only the panes removed by a successful move or a destination rollback.
const detaching = new Set<PaneId>();

export function detachTransferredPanes(ids: PaneId[]): void {
  for (const id of ids) detaching.add(id);
  // React runs passive cleanup before the next transfer of these panes can mount.
  setTimeout(() => {
    for (const id of ids) detaching.delete(id);
  }, 5000);
}

export function consumeTransferDetach(id: PaneId): boolean {
  return detaching.delete(id);
}
