// The shared update state: what the last check found and the install progress. The chip, the Settings page and the
// What's new dialog read it; `UpdatesHost` feeds it from the client. A tiny external store keeps it out of Redux.
import { useSyncExternalStore } from "react";
import type { UpdateInfo, UpdateProgress } from "./types";

export interface UpdateView {
  pending: UpdateInfo | null;
  progress: UpdateProgress | null;
  /** Downloading (in the background or from "Install"). */
  installing: boolean;
  /** Downloaded and ready; a restart finishes the update. */
  installed: boolean;
  /** The version that is ready, for the restart dialog. */
  ready: UpdateInfo | null;
  /** The restart dialog is open. */
  promptOpen: boolean;
}

let view: UpdateView = {
  pending: null,
  progress: null,
  installing: false,
  installed: false,
  ready: null,
  promptOpen: false,
};
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

/** The version used before an update: set when What's new opens by itself after one, cleared when it closes. */
let updatedFrom: string | null = null;

export function setWhatsNewSince(version: string | null): void {
  updatedFrom = version;
}

export function whatsNewSince(): string | null {
  return updatedFrom;
}
