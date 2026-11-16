// SettingsClient: the settings backend behind one interface, like PtyClient.
// - TauriSettingsClient: `settings_get`, `settings_set`, `config:changed`, `config:error`, `app_info` (typed IPC).
// - FakeSettingsClient: in memory, validates ranges like Rust does, for the browser dev server and tests.
import { listen } from "@tauri-apps/api/event";
import { commands, IpcError, unwrap } from "@tessera/ipc";
import { flattenSchema, getValue, type JsonSchema, type SettingField } from "./schema";
import type { ConfigPatch } from "./mapping";

export type ConfigObject = Record<string, unknown>;

/** The object for a section, created when missing. */
function sectionOf(config: ConfigObject, name: string): Record<string, unknown> {
  const existing = config[name];
  if (typeof existing === "object" && existing !== null) return existing as Record<string, unknown>;
  const created: Record<string, unknown> = {};
  config[name] = created;
  return created;
}

/** `config:error` payload: invalid configuration or a nonfatal unknown-key diagnostic. */
export interface ConfigDiagnostic {
  path: string;
  line: number | null;
  key: string | null;
  code: string;
  message: string;
  suggestion: string | null;
}

/** A failed `settings_set`: a stable code and a sentence; `key` names the setting when Rust knows it. */
export class SettingsError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly key: string | null = null,
  ) {
    super(message);
    this.name = "SettingsError";
  }
}

export interface SettingsInfo {
  /** Folder holding config.toml. */
  dataDir: string;
}

export interface SettingsClient {
  get(): Promise<ConfigObject>;
  /** Writes only the changed keys; resolves to the whole new config. Rejects with SettingsError. */
  set(patch: ConfigPatch): Promise<ConfigObject>;
  onChanged(listener: (config: ConfigObject) => void): Promise<() => void>;
  onError(listener: (diagnostic: ConfigDiagnostic) => void): Promise<() => void>;
  info(): Promise<SettingsInfo | null>;
}

/** The app talks to Rust when the Tauri IPC bridge exists (the real app, or Playwright's mock of it). */
export function hasIpcBridge(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

function toSettingsError(cause: unknown): SettingsError {
  if (cause instanceof SettingsError) return cause;
  const error = IpcError.from(cause);
  // Rust reports range and type errors as `config.invalid` with the key in the message prefix when known.
  const key = /`?([a-z-]+(?:\.[a-z0-9-]+)+)`?/i.exec(error.message)?.[1] ?? null;
  return new SettingsError(error.code, error.message, key);
}

export class TauriSettingsClient implements SettingsClient {
  async get(): Promise<ConfigObject> {
    try {
      return (await unwrap(commands.settingsGet())) as ConfigObject;
    } catch (cause) {
      throw toSettingsError(cause);
    }
  }

  async set(patch: ConfigPatch): Promise<ConfigObject> {
    try {
      return (await unwrap(commands.settingsSet(patch as never))) as ConfigObject;
    } catch (cause) {
      throw toSettingsError(cause);
    }
  }

  async onChanged(listener: (config: ConfigObject) => void): Promise<() => void> {
    return listen<ConfigObject>("config:changed", (event) => listener(event.payload));
  }

  async onError(listener: (diagnostic: ConfigDiagnostic) => void): Promise<() => void> {
    return listen<ConfigDiagnostic>("config:error", (event) => listener(event.payload));
  }

  async info(): Promise<SettingsInfo | null> {
    try {
      const info = await unwrap(commands.appInfo());
      return { dataDir: info.data_dir };
    } catch {
      return null;
    }
  }
}

/** In-memory settings that behave like the Rust side: defaults from the schema, range checks, change events. */
export class FakeSettingsClient implements SettingsClient {
  private config: ConfigObject;
  private readonly fields: SettingField[];
  private readonly changed = new Set<(config: ConfigObject) => void>();
  private readonly failed = new Set<(diagnostic: ConfigDiagnostic) => void>();
  /** Every patch `set` received (tests). */
  readonly patches: ConfigPatch[] = [];

  constructor(schema: JsonSchema) {
    this.fields = flattenSchema(schema);
    this.config = {};
    for (const field of this.fields) {
      sectionOf(this.config, field.section)[field.name] = field.default;
    }
  }

  async get(): Promise<ConfigObject> {
    return structuredClone(this.config);
  }

  async set(patch: ConfigPatch): Promise<ConfigObject> {
    this.patches.push(patch);
    const next = structuredClone(this.config);
    for (const [section, values] of Object.entries(patch)) {
      for (const [name, value] of Object.entries(values)) {
        const key = `${section}.${name}`;
        // `[keybindings]` is an open table: any action id maps to a chord, a list of chords, or an empty list.
        if (section === "keybindings") {
          const ok =
            typeof value === "string" || (Array.isArray(value) && value.every((item) => typeof item === "string"));
          if (!ok) throw new SettingsError("config.invalid", `${key}: expected a shortcut or a list of shortcuts`, key);
          sectionOf(next, section)[name] = value;
          continue;
        }
        const field = this.fields.find((candidate) => candidate.key === key);
        if (!field) throw new SettingsError("config.unknown_key", `Unknown setting ${key}`, key);
        const problem = validate(field, value);
        if (problem) throw new SettingsError("config.invalid", `${key}: ${problem}`, key);
        sectionOf(next, section)[name] = value;
      }
    }
    this.config = next;
    for (const listener of this.changed) listener(structuredClone(next));
    return structuredClone(next);
  }

  async onChanged(listener: (config: ConfigObject) => void) {
    this.changed.add(listener);
    return () => {
      this.changed.delete(listener);
    };
  }

  async onError(listener: (diagnostic: ConfigDiagnostic) => void) {
    this.failed.add(listener);
    return () => {
      this.failed.delete(listener);
    };
  }

  async info(): Promise<SettingsInfo | null> {
    return { dataDir: "/home/you/.tessera-dev" };
  }

  /** A hand edit of config.toml (tests, demo). */
  simulateHandEdit(key: string, value: unknown): void {
    const [section = "", ...rest] = key.split(".");
    sectionOf(this.config, section)[rest.join(".")] = value;
    for (const listener of this.changed) listener(structuredClone(this.config));
  }

  value(key: string): unknown {
    return getValue(this.config, key);
  }
}

/** The Rust-side checks the fake repeats: type, range, enum. Returns a sentence or null. */
export function validate(field: SettingField, value: unknown): string | null {
  switch (field.kind) {
    case "boolean":
      return typeof value === "boolean" ? null : "expected true or false";
    case "integer":
    case "number": {
      if (typeof value !== "number" || !Number.isFinite(value)) return "expected a number";
      if (field.kind === "integer" && !Number.isInteger(value)) return "expected a whole number";
      if (field.min !== undefined && value < field.min) return `must be at least ${field.min}`;
      if (field.max !== undefined && value > field.max) return `must be at most ${field.max}`;
      return null;
    }
    case "enum":
      return field.options?.some((option) => option.value === value)
        ? null
        : `expected one of ${field.options?.map((option) => option.value).join(", ")}`;
    case "string":
      return typeof value === "string" ? null : "expected text";
    default:
      return null;
  }
}
