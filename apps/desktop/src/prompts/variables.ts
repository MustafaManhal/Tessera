// Prompt variables (FR-43): `{{name}}` placeholders. Known names expand from the send context; unknown names are
// left untouched so a library prompt can carry placeholders for later integrations ({{issue}}).
export interface VariableValues {
  task?: string | null;
  branch?: string | null;
  issue?: string | null;
}

const KNOWN = new Set(["task", "branch", "issue"]);

/** Every `{{name}}` in the text, deduplicated, in order of first appearance. */
export function detectVariables(text: string): string[] {
  const out: string[] = [];
  for (const match of text.matchAll(/\{\{\s*([A-Za-z0-9_-]+)\s*\}\}/g)) {
    const name = match[1];
    if (name && !out.includes(name)) out.push(name);
  }
  return out;
}

/** The known FR-43 variables present in the body (what the editor previews). */
export function knownVariables(text: string): string[] {
  return detectVariables(text).filter((name) => KNOWN.has(name));
}

/** Expands `{{name}}` for names present in `values`; others (and unknown names) stay literal. */
export function expandVariables(text: string, values: VariableValues): string {
  return text.replace(/\{\{\s*([A-Za-z0-9_-]+)\s*\}\}/g, (whole, name: string) => {
    const value = values[name as keyof VariableValues];
    return value == null ? whole : value;
  });
}
