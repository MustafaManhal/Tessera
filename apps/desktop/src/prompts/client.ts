// The prompt library and history behind one interface (like the agents/inbox clients):
// TauriPromptsClient uses the generated commands; FakePromptsClient (DEV/tests) lives at window.__tesseraPrompts.
import { isTauri } from "@tauri-apps/api/core";
import { commands, unwrap } from "@tessera/ipc";

export interface PromptEntry {
  id: string;
  name: string;
  body: string;
  variables: string;
  tags: string;
  uses: number;
  createdAt: number;
  updatedAt: number;
}

export interface PromptHistoryEntry {
  id: string;
  text: string;
  targets: string;
  at: number;
}

export interface PromptInput {
  id?: string;
  name: string;
  body: string;
  variables?: string[];
  tags?: string[];
}

export interface PromptsClient {
  list(query?: string): Promise<PromptEntry[]>;
  save(input: PromptInput): Promise<PromptEntry>;
  remove(id: string): Promise<boolean>;
  used(id: string): Promise<number>;
  history(limit: number): Promise<PromptHistoryEntry[]>;
  historyAdd(text: string, targets: string[]): Promise<PromptHistoryEntry>;
}

// -- Fake (dev server and tests) ------------------------------------------------------------------------------

let nextId = 1;

export class FakePromptsClient implements PromptsClient {
  readonly prompts: PromptEntry[] = [];
  readonly historyEntries: PromptHistoryEntry[] = [];

  async list(query?: string): Promise<PromptEntry[]> {
    const needle = query?.trim().toLowerCase();
    return this.prompts
      .filter((p) => !needle || `${p.name} ${p.body} ${p.tags}`.toLowerCase().includes(needle))
      .map((p) => ({ ...p }));
  }

  async save(input: PromptInput): Promise<PromptEntry> {
    const now = Math.floor(Date.now() / 1000);
    const existing = input.id ? this.prompts.find((p) => p.id === input.id) : undefined;
    const row: PromptEntry = {
      id: input.id ?? `pr_${nextId++}`,
      name: input.name,
      body: input.body,
      variables: JSON.stringify(input.variables ?? []),
      tags: JSON.stringify(input.tags ?? []),
      uses: existing?.uses ?? 0,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    if (existing) Object.assign(existing, row);
    else this.prompts.push(row);
    return { ...row };
  }

  async remove(id: string): Promise<boolean> {
    const index = this.prompts.findIndex((p) => p.id === id);
    if (index < 0) return false;
    this.prompts.splice(index, 1);
    return true;
  }

  async used(id: string): Promise<number> {
    const row = this.prompts.find((p) => p.id === id);
    if (!row) return 0;
    row.uses += 1;
    return row.uses;
  }

  async history(limit: number): Promise<PromptHistoryEntry[]> {
    return this.historyEntries
      .slice(-limit)
      .reverse()
      .map((e) => ({ ...e }));
  }

  async historyAdd(text: string, targets: string[]): Promise<PromptHistoryEntry> {
    const row: PromptHistoryEntry = {
      id: `h_${nextId++}`,
      text,
      targets: JSON.stringify(targets),
      at: Math.floor(Date.now() / 1000),
    };
    this.historyEntries.push(row);
    if (this.historyEntries.length > 500) this.historyEntries.splice(0, this.historyEntries.length - 500);
    return { ...row };
  }
}

// -- Tauri -----------------------------------------------------------------------------------------------------

const fromRecord = (row: {
  id: string;
  name: string;
  body: string;
  variables: string;
  tags: string;
  uses: number;
  createdAt: number;
  updatedAt: number;
}): PromptEntry => ({ ...row });

class TauriPromptsClient implements PromptsClient {
  async list(query?: string): Promise<PromptEntry[]> {
    return (await unwrap(commands.promptsList(query ?? null))).map(fromRecord);
  }
  async save(input: PromptInput): Promise<PromptEntry> {
    return fromRecord(
      await unwrap(
        commands.promptSave({
          id: input.id ?? null,
          name: input.name,
          body: input.body,
          variables: input.variables ?? [],
          tags: input.tags ?? [],
        }),
      ),
    );
  }
  async remove(id: string): Promise<boolean> {
    return unwrap(commands.promptDelete(id));
  }
  async used(id: string): Promise<number> {
    return unwrap(commands.promptUsed(id));
  }
  async history(limit: number): Promise<PromptHistoryEntry[]> {
    return unwrap(commands.promptHistoryList(limit));
  }
  async historyAdd(text: string, targets: string[]): Promise<PromptHistoryEntry> {
    return unwrap(commands.promptHistoryAdd(text, targets));
  }
}

// -- Singleton -------------------------------------------------------------------------------------------------

declare global {
  interface Window {
    __tesseraPrompts?: PromptsClient;
  }
}

let client: PromptsClient | null = null;

// DEV/tests: expose the fake eagerly so specs can seed it before the first prompts() call.
if (import.meta.env.DEV && !isTauri() && typeof window !== "undefined" && !window.__tesseraPrompts) {
  window.__tesseraPrompts = new FakePromptsClient();
}

export function prompts(): PromptsClient {
  if (!client) {
    client =
      import.meta.env.DEV && !isTauri()
        ? ((window.__tesseraPrompts as FakePromptsClient) ?? new FakePromptsClient())
        : new TauriPromptsClient();
    if (import.meta.env.DEV && typeof window !== "undefined") window.__tesseraPrompts = client;
  }
  return client;
}
