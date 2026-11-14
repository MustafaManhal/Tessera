// Keeps the Redux `settings.terminal` slice and config.toml in step (FR-65):
// - at start: `settings_get` → `configApplied`; later `config:changed` (our own writes and hand edits) → `configApplied`;
// - `config:error` → `configDiagnostic` (the last good values stay);
// - a change made inside the app (font zoom, ligatures toggle, "Always allow") → `settings_set`, debounced 250 ms.
import type { AppStore } from "../store";
import { configApplied, configDiagnostic } from "../store/configSlice";
import { announce } from "../store/uiSlice";
import type { SettingsClient } from "./client";
import { type ConfigPatch, terminalPatchToConfig } from "./mapping";
import { getValue } from "./schema";

export const SAVE_DEBOUNCE_MS = 250;

function merge(into: ConfigPatch, from: ConfigPatch): void {
  for (const [section, values] of Object.entries(from)) into[section] = { ...into[section], ...values };
}

/** Starts the sync; returns the stop function. */
export function startSettingsSync(client: SettingsClient, store: AppStore): () => void {
  let stopped = false;
  let applying = false;
  let last = store.getState().settings.terminal;
  let pending: ConfigPatch | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const unsubscribers: (() => void)[] = [];

  const apply = (config: Parameters<typeof configApplied>[0]) => {
    if (stopped) return;
    applying = true;
    store.dispatch(configApplied(config));
    last = store.getState().settings.terminal;
    applying = false;
  };

  const flush = async () => {
    timer = null;
    const patch = pending;
    pending = null;
    if (!patch || stopped) return;
    try {
      apply(await client.set(patch));
    } catch (cause) {
      // Rust refused (range, type): fall back to what the file says and tell the user.
      store.dispatch(announce(cause instanceof Error ? cause.message : String(cause)));
      try {
        apply(await client.get());
      } catch {
        // No backend answer either: keep the local values.
      }
    }
  };

  const unsubscribeStore = store.subscribe(() => {
    if (applying) return;
    const now = store.getState().settings.terminal;
    if (now === last) return;
    const patch = terminalPatchToConfig(last, now);
    last = now;
    if (!patch) return;
    // Keys the config already holds (a change that came from the config, or the settings screen) are not written back.
    const known = store.getState().config.values;
    for (const [section, values] of Object.entries(patch)) {
      for (const [name, value] of Object.entries(values)) {
        if (JSON.stringify(getValue(known, `${section}.${name}`)) === JSON.stringify(value)) delete values[name];
      }
      if (Object.keys(values).length === 0) delete patch[section];
    }
    if (Object.keys(patch).length === 0) return;
    pending ??= {};
    merge(pending, patch);
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void flush(), SAVE_DEBOUNCE_MS);
  });
  unsubscribers.push(unsubscribeStore);

  void client
    .get()
    .then(apply)
    .catch(() => {
      // No backend (a bare browser without IPC): the slice keeps its defaults.
    });
  void client.onChanged(apply).then(
    (off) => (stopped ? off() : unsubscribers.push(off)),
    () => {},
  );
  void client
    .onError((diagnostic) => store.dispatch(configDiagnostic(diagnostic)))
    .then(
      (off) => (stopped ? off() : unsubscribers.push(off)),
      () => {},
    );

  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    for (const off of unsubscribers) off();
  };
}
