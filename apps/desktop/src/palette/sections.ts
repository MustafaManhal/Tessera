// What the command palette lists for a query: recent actions first and then the groups when the query is empty, or
// one list ranked by the fuzzy matcher. Pure, so it is unit-tested without a DOM.
import { type StringKey, t } from "@tessera/ui";
import { type ActionGroup, type AppAction, type Availability, GROUP_LABELS } from "../actions/registry";
import { type FuzzyMatch, rank } from "./fuzzy";

export interface Entry {
  action: AppAction;
  label: string;
  available: Availability;
}

export interface Section {
  heading: StringKey | null;
  items: { entry: Entry; match: FuzzyMatch | null }[];
}

/** ">" asks for actions (the only kind today). Reserved for later: "#" tasks, "@" projects, "/" files. */
const ACTION_PREFIX = /^>\s*/;
const GROUP_ORDER: ActionGroup[] = ["tabs", "panes", "projects", "terminal", "view"];

/** The sections the palette shows for a query. */
export function paletteSections(query: string, entries: readonly Entry[], recent: readonly string[]): Section[] {
  const q = query.replace(ACTION_PREFIX, "").trim();
  if (q === "") {
    const recentEntries = recent.flatMap((id) => entries.filter((entry) => entry.action.id === id));
    const shown = new Set(recentEntries.map((entry) => entry.action.id));
    const sections: Section[] = [];
    if (recentEntries.length > 0) {
      sections.push({ heading: "group.recent", items: recentEntries.map((entry) => ({ entry, match: null })) });
    }
    for (const group of GROUP_ORDER) {
      const items = entries.filter((entry) => entry.action.group === group && !shown.has(entry.action.id));
      if (items.length > 0)
        sections.push({ heading: GROUP_LABELS[group], items: items.map((entry) => ({ entry, match: null })) });
    }
    return sections;
  }
  const ranked = rank(
    q,
    entries,
    (entry) => entry.label,
    (entry) => [...(entry.action.keywords ?? []), t(GROUP_LABELS[entry.action.group])],
  );
  return ranked.length > 0 ? [{ heading: null, items: ranked.map(({ item, match }) => ({ entry: item, match })) }] : [];
}

/** Splits a label into runs of matched and unmatched characters (keyed by where each run starts). */
export function highlightRuns(
  text: string,
  indices: readonly number[],
): { start: number; text: string; hit: boolean }[] {
  const hits = new Set(indices);
  const runs: { start: number; text: string; hit: boolean }[] = [];
  Array.from(text).forEach((char, index) => {
    const hit = hits.has(index);
    const last = runs.at(-1);
    if (last && last.hit === hit) last.text += char;
    else runs.push({ start: index, text: char, hit });
  });
  return runs;
}
