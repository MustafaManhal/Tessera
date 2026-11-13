// The S-16 inbox behind one interface, like the agents client:
// - TauriInboxClient: the generated `notifications_*` commands.
// - FakeInboxClient (this file, DEV/tests): in-memory rows at `window.__tesseraInbox`.
import { isTauri } from "@tauri-apps/api/core";
import { commands, unwrap } from "@tessera/ipc";

export interface InboxEntry {
  id: string;
  source: string;
  taskId: string | null;
  paneSessionId: string | null;
  title: string;
  body: string;
  isRead: boolean;
  /** Unix seconds. */
  at: number;
}

export interface RecordInboxEntry {
  source: string;
  taskId: string | null;
  paneSessionId: string | null;
  title: string;
  body: string;
}

declare global {
  interface Window {
    __tesseraInbox?: InboxClient;
  }
}

export interface InboxClient {
  list(limit: number): Promise<InboxEntry[]>;
  /** `ids` marks those rows; null marks everything. */
  markRead(ids: string[] | null): Promise<void>;
  clear(): Promise<void>;
  record(entry: RecordInboxEntry): Promise<InboxEntry>;
}

// -- Fake (dev server and tests) ------------------------------------------------------------------------------

let nextId = 1;

export class FakeInboxClient implements InboxClient {
  readonly entries: InboxEntry[] = [];

  async list(limit: number): Promise<InboxEntry[]> {
    // Unread first, then newest — mirrors the store's ORDER BY is_read, at DESC.
    return this.entries
      .slice()
      .sort((a, b) => Number(a.isRead) - Number(b.isRead) || b.at - a.at)
      .slice(0, limit)
      .map((entry) => ({ ...entry }));
  }

  async markRead(ids: string[] | null): Promise<void> {
    for (const entry of this.entries) {
      if (ids === null || ids.includes(entry.id)) entry.isRead = true;
    }
  }

  async clear(): Promise<void> {
    this.entries.length = 0;
  }

  async record(entry: RecordInboxEntry): Promise<InboxEntry> {
    const row: InboxEntry = { id: `n_${nextId++}`, isRead: false, at: Math.floor(Date.now() / 1000), ...entry };
    this.entries.push(row);
    return { ...row };
  }
}

// -- Tauri -----------------------------------------------------------------------------------------------------

class TauriInboxClient implements InboxClient {
  async list(limit: number): Promise<InboxEntry[]> {
    const rows = await unwrap(commands.notificationsList(limit));
    return rows.map((row) => ({
      id: row.id,
      source: row.source,
      taskId: row.taskId ?? null,
      paneSessionId: row.paneSessionId ?? null,
      title: row.title,
      body: row.body,
      isRead: row.isRead,
      at: row.at,
    }));
  }

  async markRead(ids: string[] | null): Promise<void> {
    await unwrap(commands.notificationsMarkRead(ids));
  }

  async clear(): Promise<void> {
    await unwrap(commands.notificationsClear());
  }

  async record(entry: RecordInboxEntry): Promise<InboxEntry> {
    const row = await unwrap(
      commands.notificationsRecord({
        source: entry.source,
        taskId: entry.taskId,
        paneSessionId: entry.paneSessionId,
        title: entry.title,
        body: entry.body,
      }),
    );
    return {
      id: row.id,
      source: row.source,
      taskId: row.taskId ?? null,
      paneSessionId: row.paneSessionId ?? null,
      title: row.title,
      body: row.body,
      isRead: row.isRead,
      at: row.at,
    };
  }
}

// -- Singleton -------------------------------------------------------------------------------------------------

let client: InboxClient | null = null;

export function inbox(): InboxClient {
  if (!client) {
    client = import.meta.env.DEV && !isTauri() ? new FakeInboxClient() : new TauriInboxClient();
    if (import.meta.env.DEV && typeof window !== "undefined") window.__tesseraInbox = client;
  }
  return client;
}
