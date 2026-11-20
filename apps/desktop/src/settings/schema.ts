// Turns the config JSON Schema (packages/ipc/schema/config.schema.json) into a flat list of settings the screen can
// draw, so a setting added in Rust appears without new UI code (FR-65). Pure and unit-tested.
//
// A field's `kind` decides its control: boolean → switch, integer/number → number input with its range, enum → select,
// string → text, list → comma-separated text, chords (keybindings) and anything unknown → read-only text.

export type FieldKind = "boolean" | "integer" | "number" | "enum" | "string" | "list" | "chords" | "readonly";

export interface EnumOption {
  value: string;
  description: string;
}

export interface SettingField {
  /** Dotted key as in config.toml: `terminal.cursor-style`. */
  key: string;
  /** TOML section: `terminal`. */
  section: string;
  /** Key inside the section: `cursor-style`. */
  name: string;
  description: string;
  kind: FieldKind;
  default: unknown;
  min?: number;
  max?: number;
  options?: EnumOption[];
}

type Json = Record<string, unknown>;

export interface JsonSchema {
  properties?: Record<string, Json>;
  $defs?: Record<string, Json>;
}

const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Follows `$ref: "#/$defs/Name"` (the only form the schema uses); other refs resolve to nothing. */
function resolve(schema: JsonSchema, node: Json): Json {
  const ref = node.$ref;
  if (typeof ref !== "string") return node;
  const match = /^#\/\$defs\/(.+)$/.exec(ref);
  const target = match?.[1] ? schema.$defs?.[match[1]] : undefined;
  // The property's own description and default win over the definition's.
  return target ? { ...target, ...node, $ref: undefined } : node;
}

function enumOptions(node: Json): EnumOption[] | null {
  const list = node.oneOf;
  if (!Array.isArray(list) || list.length === 0) return null;
  const options: EnumOption[] = [];
  for (const entry of list) {
    if (!isObject(entry) || typeof entry.const !== "string") return null;
    options.push({ value: entry.const, description: typeof entry.description === "string" ? entry.description : "" });
  }
  return options;
}

function kindOf(node: Json): Pick<SettingField, "kind" | "options" | "min" | "max"> {
  const options = enumOptions(node);
  if (options) return { kind: "enum", options };
  if (Array.isArray(node.anyOf)) {
    // Keybinding: a string or a list of strings.
    return { kind: "chords" };
  }
  const range = {
    min: typeof node.minimum === "number" ? node.minimum : undefined,
    max: typeof node.maximum === "number" ? node.maximum : undefined,
  };
  switch (node.type) {
    case "boolean":
      return { kind: "boolean" };
    case "integer":
      return { kind: "integer", ...range };
    case "number":
      return { kind: "number", ...range };
    case "string":
      return { kind: "string" };
    case "array": {
      const items = node.items;
      return isObject(items) && items.type === "string" ? { kind: "list" } : { kind: "readonly" };
    }
    default:
      return { kind: "readonly" };
  }
}

/** Every leaf setting of every section, in schema order (sections as the schema lists them). */
export function flattenSchema(schema: JsonSchema): SettingField[] {
  const fields: SettingField[] = [];
  for (const [section, sectionNode] of Object.entries(schema.properties ?? {})) {
    const resolved = resolve(schema, sectionNode);
    const properties = resolved.properties;
    if (!isObject(properties)) continue;
    for (const [name, raw] of Object.entries(properties)) {
      if (!isObject(raw)) continue;
      const node = resolve(schema, raw);
      const keybinding = Array.isArray(node.anyOf);
      fields.push({
        key: `${section}.${name}`,
        section,
        name,
        description: typeof raw.description === "string" ? raw.description : String(node.description ?? ""),
        default: raw.default ?? node.default,
        ...(keybinding ? { kind: "chords" as const } : kindOf(node)),
      });
    }
  }
  return fields;
}

/** The value of a dotted key in a config object, or undefined. */
export function getValue(config: unknown, key: string): unknown {
  let current: unknown = config;
  const [section, ...rest] = key.split(".");
  if (!section) return undefined;
  current = isObject(current) ? current[section] : undefined;
  if (!isObject(current)) return undefined;
  return current[rest.join(".")];
}

/** `{terminal: {"cursor-style": value}}` for one dotted key. */
export function patchFor(key: string, value: unknown): Record<string, Record<string, unknown>> {
  const [section = "", ...rest] = key.split(".");
  return { [section]: { [rest.join(".")]: value } };
}

/** Parses what the user typed into a field's value; `error` is a catalog key when it cannot be parsed. */
export function parseInput(
  field: SettingField,
  text: string,
): { value: unknown } | { error: "invalidNumber" | "invalidInteger" } {
  switch (field.kind) {
    case "integer": {
      if (!/^-?\d+$/.test(text.trim())) return { error: "invalidInteger" };
      return { value: Number(text) };
    }
    case "number": {
      const trimmed = text.trim();
      if (trimmed === "" || !Number.isFinite(Number(trimmed))) return { error: "invalidNumber" };
      return { value: Number(trimmed) };
    }
    case "list":
      return {
        value: text
          .split(",")
          .map((part) => part.trim())
          .filter(Boolean),
      };
    default:
      return { value: text };
  }
}

/** Text shown in a field for a value. */
export function formatValue(value: unknown): string {
  if (Array.isArray(value)) return value.map(String).join(", ");
  if (value === null || value === undefined) return "";
  return String(value);
}

/** Whether a field matches a search query (label, key, description, enum values; every word must match). */
export function matchesQuery(field: SettingField, label: string, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const hay = [label, field.key, field.description, ...(field.options?.map((option) => option.value) ?? [])]
    .join(" ")
    .toLowerCase();
  return words.every((word) => hay.includes(word));
}

/** Section order and names shown in the screen (config sections grouped into the S-11 list). */
export const SECTION_GROUPS: { id: string; sections: string[] }[] = [
  { id: "general", sections: ["shell", "worktrees", "editor"] },
  { id: "appearance", sections: ["appearance"] },
  { id: "font", sections: ["font"] },
  { id: "terminal", sections: ["terminal", "quick-terminal"] },
  { id: "notifications", sections: ["notifications"] },
  { id: "updates", sections: ["updates"] },
  { id: "advanced", sections: ["api"] },
];

/** Sections with their own stub page ("Comes in a later version"). */
export const STUB_GROUPS = ["keybindings", "agents", "integrations"] as const;
