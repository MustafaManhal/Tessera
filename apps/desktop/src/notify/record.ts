// One way to add a row to the notifications panel: everything Tessera tells the user (agent events, errors, finished
// commands, program notifications, toasts) lands there. Attention rows (agent needs you, errors) stay unread; plain
// status messages are recorded as read so the unread count keeps meaning "look at this".
import type { ToastOptions } from "@tessera/ui";
import { store } from "../store";
import { bumpInbox } from "../store/uiSlice";
import { inbox, type RecordInboxEntry } from "./inbox";

export interface InboxRecord extends Partial<RecordInboxEntry> {
  source: string;
  title: string;
  body?: string;
  /** Recorded as read: shown in the list, not counted as unread. */
  read?: boolean;
}

export async function recordInbox(entry: InboxRecord): Promise<void> {
  try {
    const row = await inbox().record({
      source: entry.source,
      taskId: entry.taskId ?? null,
      paneSessionId: entry.paneSessionId ?? null,
      title: entry.title,
      body: entry.body ?? "",
    });
    if (entry.read) await inbox().markRead([row.id]);
  } catch {
    // The list is a convenience; a failed write never interrupts what was being reported.
  } finally {
    store.dispatch(bumpInbox());
  }
}

/** The toast listener: every toast also becomes a row, errors unread. */
export function recordToast(options: ToastOptions): void {
  if (options.inbox === false) return;
  const kind = options.kind ?? "info";
  void recordInbox({ source: kind, title: options.title, body: options.description ?? "", read: kind !== "error" });
}
