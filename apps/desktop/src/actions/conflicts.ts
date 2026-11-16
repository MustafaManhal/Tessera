// Conflicts between shortcuts (FR-67), found before a binding is saved and when the config is read:
//   - duplicate: the same chord on two actions in the same scope;
//   - reserved: a chord that would steal a key the shell or a full-screen program needs (Ctrl+C, Ctrl+D, Esc, …);
//   - noModifier: a chord with no modifier on a key that types text (the terminal could never type it again).
// Pure: the registry's resolved bindings go in, structured conflicts come out.
import type { Platform } from "@tessera/ui";
import { type ChordSpec, canonicalFor, parseChordText } from "./chord";

export interface BindingEntry {
  actionId: string;
  /** Chord text as bound ("Ctrl+Shift+T"). */
  keys: string;
  scope?: "tabStrip";
}

export type Conflict =
  | { kind: "duplicate"; keys: string; scope: "global" | "tabStrip"; actions: string[] }
  | { kind: "reserved"; keys: string; actions: string[]; reason: ReservedReason }
  | { kind: "noModifier"; keys: string; actions: string[] };

export type ReservedReason = "controlKey" | "escape" | "editing";

const TEXT_KEY = /^([A-Z0-9]|Space|[[\]/\\,.;'`=+-])$/;
const LETTER = /^[A-Z]$/;

/** Does the chord use the Ctrl key (as itself or as Mod on Windows)? */
function usesCtrl(spec: ChordSpec, platform: Platform): boolean {
  return spec.ctrl || (spec.mod && platform !== "mac");
}

/** Why a chord is reserved for the terminal on this platform, or null. */
export function reservedReason(spec: ChordSpec, platform: Platform): ReservedReason | null {
  const onlyCtrl =
    usesCtrl(spec, platform) && !spec.alt && !spec.shift && !spec.meta && !(spec.mod && platform === "mac");
  // Ctrl+letter is a control character the shell reads (C, D, Z, L, R, A, E, K, U, W, …).
  if (onlyCtrl && LETTER.test(spec.key)) return "controlKey";
  const bare = !spec.mod && !spec.meta && !spec.ctrl && !spec.alt;
  if (bare && !spec.shift && spec.key === "Escape") return "escape";
  if (bare && !spec.shift && (spec.key === "Tab" || spec.key === "Enter" || spec.key === "Backspace")) return "editing";
  return null;
}

/** A modifier-free (or Shift-only) chord on a key that types text. */
export function isBareTextKey(spec: ChordSpec): boolean {
  return !spec.mod && !spec.meta && !spec.ctrl && !spec.alt && TEXT_KEY.test(spec.key);
}

export function detectConflicts(entries: readonly BindingEntry[], platform: Platform): Conflict[] {
  const out: Conflict[] = [];
  const seen = new Map<string, { scope: "global" | "tabStrip"; keys: string; actions: Set<string> }>();
  for (const entry of entries) {
    const canonical = canonicalFor(entry.keys, platform);
    if (!canonical) continue;
    const scope = entry.scope ?? "global";
    const id = `${scope}:${canonical}`;
    const group = seen.get(id) ?? { scope, keys: canonical, actions: new Set<string>() };
    group.actions.add(entry.actionId);
    seen.set(id, group);
  }
  for (const group of seen.values()) {
    const actions = [...group.actions];
    if (actions.length > 1) out.push({ kind: "duplicate", keys: group.keys, scope: group.scope, actions });
    const spec = parseChordText(group.keys);
    if (!spec || group.scope === "tabStrip") continue;
    const reason = reservedReason(spec, platform);
    if (reason) out.push({ kind: "reserved", keys: group.keys, actions, reason });
    else if (isBareTextKey(spec)) out.push({ kind: "noModifier", keys: group.keys, actions });
  }
  return out;
}

/** The conflicts a new chord for an action would create (used by the recorder before saving). */
export function conflictsFor(
  actionId: string,
  keys: string,
  existing: readonly BindingEntry[],
  platform: Platform,
): Conflict[] {
  const trial = [
    ...existing.filter((entry) => !(entry.actionId === actionId && (entry.scope ?? "global") === "global")),
    { actionId, keys },
  ];
  return detectConflicts(trial, platform).filter((conflict) => conflict.actions.includes(actionId));
}
