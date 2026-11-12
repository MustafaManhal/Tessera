// Fuzzy matching for the command palette: the query's characters must appear in order (case-insensitive). Matches at
// the start, at word starts and in runs score higher; gaps cost a little. Returns the matched positions so the
// palette can highlight them.

export interface FuzzyMatch {
  score: number;
  /** Indexes of the matched characters in the text. */
  indices: number[];
}

const START = 8;
const WORD_START = 6;
const RUN = 4;
const GAP = 0.5;
const MAX_GAP_PENALTY = 3;

function isWordStart(text: string, index: number): boolean {
  if (index === 0) return true;
  const before = text[index - 1] ?? "";
  const here = text[index] ?? "";
  if (/[\s\-_./:\\]/.test(before)) return true;
  return before.toLowerCase() === before && here.toUpperCase() === here && /[a-z]/i.test(here);
}

/** Best match of `query` in `text`, or null when the characters do not all appear in order. */
export function fuzzyMatch(query: string, text: string): FuzzyMatch | null {
  const q = query.trim().toLowerCase();
  if (q === "") return { score: 0, indices: [] };
  const lower = text.toLowerCase();
  const n = q.length;
  const m = lower.length;
  if (n > m) return null;

  // best[i][j]: best score with q[0..i] matched and q[i] at text[j]; from[i][j]: where q[i-1] was matched.
  const best: number[][] = Array.from({ length: n }, () => new Array<number>(m).fill(Number.NEGATIVE_INFINITY));
  const from: number[][] = Array.from({ length: n }, () => new Array<number>(m).fill(-1));
  for (let i = 0; i < n; i++) {
    const row = best[i] as number[];
    const back = from[i] as number[];
    for (let j = i; j < m; j++) {
      if (lower[j] !== q[i]) continue;
      const bonus = 1 + (j === 0 ? START : 0) + (isWordStart(text, j) ? WORD_START : 0);
      if (i === 0) {
        row[j] = bonus - Math.min(MAX_GAP_PENALTY, j * GAP);
        continue;
      }
      const previous = best[i - 1] as number[];
      for (let k = i - 1; k < j; k++) {
        const prior = previous[k] as number;
        if (prior === Number.NEGATIVE_INFINITY) continue;
        const gap = j - k - 1;
        const score = prior + bonus + (gap === 0 ? RUN : -Math.min(MAX_GAP_PENALTY, gap * GAP));
        if (score > (row[j] as number)) {
          row[j] = score;
          back[j] = k;
        }
      }
    }
  }

  const lastRow = best[n - 1] as number[];
  let end = -1;
  for (let j = 0; j < m; j++) if (end === -1 || (lastRow[j] as number) > (lastRow[end] as number)) end = j;
  if (end === -1 || lastRow[end] === Number.NEGATIVE_INFINITY) return null;
  const indices: number[] = [];
  for (let i = n - 1, j = end; i >= 0; i--) {
    indices.unshift(j);
    j = (from[i] as number[])[j] as number;
  }
  return { score: lastRow[end] as number, indices };
}

export interface Ranked<T> {
  item: T;
  match: FuzzyMatch;
}

/**
 * Filters and orders items by their best match: on the label (highlighted), else on a keyword (scored lower, not
 * highlighted). Ties keep the original order.
 */
export function rank<T>(
  query: string,
  items: readonly T[],
  label: (item: T) => string,
  keywords?: (item: T) => string[],
): Ranked<T>[] {
  const ranked: (Ranked<T> & { order: number })[] = [];
  items.forEach((item, order) => {
    const onLabel = fuzzyMatch(query, label(item));
    let match = onLabel;
    if (!match) {
      const scores = (keywords?.(item) ?? []).flatMap((word) => {
        const hit = fuzzyMatch(query, word);
        return hit ? [hit.score * 0.6] : [];
      });
      if (scores.length > 0) match = { score: Math.max(...scores), indices: [] };
    }
    if (match) ranked.push({ item, match, order });
  });
  ranked.sort((a, b) => b.match.score - a.match.score || a.order - b.order);
  return ranked.map(({ item, match }) => ({ item, match }));
}
