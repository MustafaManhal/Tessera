// The shared update state: what the last check found and the install progress. The chip, the Settings page and the
// What's new dialog read it; `UpdatesHost` feeds it from the client. A tiny external store keeps it out of Redux.
import { useSyncExternalStore } from "react";
import type { UpdateInfo, UpdateProgress } from "./types";

export interface UpdateView {
  pending: UpdateInfo | null;
  progress: UpdateProgress | null;
  installing: boolean;
  /** Installed; a restart finishes the update. */
  installed: boolean;
}

let view: UpdateView = { pending: null, progress: null, installing: false, installed: false };
const listeners = new Set<() => void>();

export function setUpdateView(patch: Partial<UpdateView>): void {
  view = { ...view, ...patch };
  for (const listener of listeners) listener();
}

export function useUpdateView(): UpdateView {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    () => view,
  );
}
