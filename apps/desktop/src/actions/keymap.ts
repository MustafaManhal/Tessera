// The live keymap (FR-67): the platform preset's defaults, merged with the user's overrides from config `[keybindings]`.
// A module-level store (the key handler, tooltips, the palette and the shortcut sheet all read it; `version` changes
// whenever it does, for `useSyncExternalStore`).
//
// Overrides: the config maps an action id to one chord, a list of chords, or nothing (`""`, `null`, `[]` unbinds).
// A chord that cannot be read is ignored and reported (`problems`) with its key; the action keeps its default.
// Chords the config only holds as the schema's own defaults are not overrides (they are written for macOS).
// An override replaces an action's global chords; its tab-strip-only chords (F2, Delete, Alt+Shift+arrows) stay, and a
// native-clipboard binding (paste) stays native.
import type { Platform } from "@tessera/ui";
import { canonicalFor, normalizeChord } from "./chord";
import { type PresetName, presetFor } from "./presets";

export type ShortcutSpec = string | { keys: string; scope?: "tabStrip"; native?: true };

export interface KeymapEntry {
  keys: string;
  scope?: "tabStrip";
  native?: boolean;
}

export interface KeymapProblem {
  /** The config key (an action id or its alias). */
  key: string;
  /** What the file held for it. */
  value: string;
  reason: "invalidChord" | "unknownAction" | "invalidValue";
}

/** Config key names that differ from registry ids (schema §5.1). */
export const ACTION_ALIASES: Record<string, string> = { "palette.open": "view.palette" };

/** The registry id a config key stands for. */
export function actionIdFor(key: string): string {
  return ACTION_ALIASES[key] ?? key;
}

/** The config key to write for a registry id (the inverse of `actionIdFor`). */
export function configKeyFor(actionId: string): string {
  for (const [key, id] of Object.entries(ACTION_ALIASES)) if (id === actionId) return key;
  return actionId;
}

const asEntry = (spec: ShortcutSpec): KeymapEntry =>
  typeof spec === "string"
    ? { keys: spec }
    : { keys: spec.keys, ...(spec.scope ? { scope: spec.scope } : {}), ...(spec.native ? { native: true } : {}) };

interface State {
  preset: PresetName;
  /** Action id → normalised chords; an empty list unbinds. */
  overrides: Record<string, string[]>;
  problems: KeymapProblem[];
  known: ReadonlySet<string> | null;
  version: number;
  recording: boolean;
}

const state: State = { preset: "default", overrides: {}, problems: [], known: null, version: 0, recording: false };
const listeners = new Set<() => void>();

function changed(): void {
  state.version += 1;
  for (const listener of listeners) listener();
}

export const keymap = {
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  version(): number {
    return state.version;
  },
  /** The registry tells the keymap which action ids exist (to report overrides for actions that do not). */
  setKnownActions(ids: Iterable<string>): void {
    state.known = new Set(ids);
  },
  get preset(): PresetName {
    return state.preset;
  },
  setPreset(preset: PresetName): void {
    if (preset === state.preset) return;
    state.preset = preset;
    changed();
  },
  get overrides(): Readonly<Record<string, string[]>> {
    return state.overrides;
  },
  get problems(): readonly KeymapProblem[] {
    return state.problems;
  },
  /** While true the global key handler stays out (the recorder is listening). */
  get recording(): boolean {
    return state.recording;
  },
  setRecording(recording: boolean): void {
    state.recording = recording;
  },

  /**
   * Reads the config's `[keybindings]` table. `defaults` are the schema defaults per key, which do not count as
   * overrides. Returns the problems found (also kept in `problems`).
   */
  setOverrides(
    raw: unknown,
    defaults: Readonly<Record<string, unknown>> = {},
    platform: Platform = "windows",
  ): KeymapProblem[] {
    const overrides: Record<string, string[]> = {};
    const problems: KeymapProblem[] = [];
    const table =
      typeof raw === "object" && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
    for (const [key, value] of Object.entries(table)) {
      if (JSON.stringify(value) === JSON.stringify(defaults[key])) continue;
      const id = actionIdFor(key);
      const shown = typeof value === "string" ? value : JSON.stringify(value);
      if (state.known && !state.known.has(id)) {
        problems.push({ key, value: shown, reason: "unknownAction" });
        continue;
      }
      let list: unknown[];
      if (value === null || value === undefined || value === "") list = [];
      else if (typeof value === "string") list = [value];
      else if (Array.isArray(value)) list = value;
      else {
        problems.push({ key, value: shown, reason: "invalidValue" });
        continue;
      }
      const chords: string[] = [];
      let bad = false;
      for (const item of list) {
        const normalised = typeof item === "string" ? normalizeChord(item) : null;
        if (normalised) {
          if (!chords.includes(normalised)) chords.push(normalised);
        } else {
          bad = true;
          problems.push({ key, value: typeof item === "string" ? item : JSON.stringify(item), reason: "invalidChord" });
        }
      }
      // An action whose every chord is unreadable keeps its default; an explicit empty list unbinds it.
      if (bad && chords.length === 0) continue;
      // Writing an action's own default is how "Reset" works through a patch: it is not a customisation.
      const own = keymap
        .defaults(id, platform)
        .filter((entry) => entry.scope === undefined)
        .map((entry) => canonicalFor(entry.keys, platform));
      if (chords.length === own.length && chords.every((chord, index) => canonicalFor(chord, platform) === own[index]))
        continue;
      overrides[id] = chords;
    }
    const same = JSON.stringify(overrides) === JSON.stringify(state.overrides);
    state.overrides = overrides;
    state.problems = problems;
    if (!same) changed();
    return problems;
  },

  /** An action's default shortcuts on a platform (the preset). */
  defaults(actionId: string, platform: Platform): KeymapEntry[] {
    return (presetFor(platform, state.preset)[actionId] ?? []).map(asEntry);
  },

  /** What is bound now: the defaults with the override applied. */
  entries(actionId: string, platform: Platform): KeymapEntry[] {
    const defaults = keymap.defaults(actionId, platform);
    const override = state.overrides[actionId];
    if (override === undefined) return defaults;
    const native = defaults.some((entry) => entry.native);
    const scoped = defaults.filter((entry) => entry.scope !== undefined);
    return [...override.map((keys): KeymapEntry => ({ keys, ...(native ? { native: true } : {}) })), ...scoped];
  },

  /** Whether an action's bound chords differ from its defaults. */
  isCustom(actionId: string): boolean {
    return state.overrides[actionId] !== undefined;
  },

  /** Is `keys` one of the action's default global chords? */
  isDefaultChord(actionId: string, keys: string, platform: Platform): boolean {
    return keymap
      .defaults(actionId, platform)
      .some(
        (entry) => entry.scope === undefined && canonicalFor(entry.keys, platform) === canonicalFor(keys, platform),
      );
  },

  /** Test helper: back to the defaults. */
  reset(): void {
    state.preset = "default";
    state.overrides = {};
    state.problems = [];
    state.recording = false;
    changed();
  },
};
