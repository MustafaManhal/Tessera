// OS notifications behind one adapter (FR-10):
// - Tauri: @tauri-apps/plugin-notification. On macOS and Windows the plugin reports the permission as granted and
//   the OS asks the user itself on first use; clicks reach `onAction` only on mobile, so on desktop a click just
//   raises the app (the lead may wire a desktop click later; see the brief 08 report).
// - Browser (dev server): the Notification API.
// - Tests (navigator.webdriver) and dev builds without either: a recording sink at `window.__tesseraNotifications`,
//   whose `permission` a test can set and whose `click(index)` acts like clicking a shown notification.
import { isTauri } from "@tauri-apps/api/core";
import type { PaneId } from "../layout";
import { reportNativeCommandError } from "./errors";

export type NotificationPermission = "granted" | "denied" | "default";

export interface OsNotification {
  paneId: PaneId;
  title: string;
  body: string;
}

export interface NotificationSink {
  permission(): Promise<NotificationPermission>;
  requestPermission(): Promise<NotificationPermission>;
  show(notification: OsNotification): void;
  /** A click on a notification: the pane it came from. Returns the unsubscribe. */
  onActivate(listener: (paneId: PaneId) => void): () => void;
}

export interface RecordingSink extends NotificationSink {
  permissionState: NotificationPermission;
  /** What `requestPermission` turns the permission into. */
  answer: NotificationPermission;
  readonly shown: OsNotification[];
  requests: number;
  click(index: number): void;
}

declare global {
  interface Window {
    __tesseraNotifications?: RecordingSink;
  }
}

export function createRecordingSink(): RecordingSink {
  const listeners = new Set<(paneId: PaneId) => void>();
  const sink: RecordingSink = {
    permissionState: "granted",
    answer: "granted",
    shown: [],
    requests: 0,
    permission: async () => sink.permissionState,
    requestPermission: async () => {
      sink.requests += 1;
      sink.permissionState = sink.answer;
      return sink.permissionState;
    },
    show: (notification) => {
      sink.shown.push(notification);
    },
    onActivate: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    click: (index) => {
      const notification = sink.shown[index];
      if (notification) for (const listener of listeners) listener(notification.paneId);
    },
  };
  return sink;
}

function tauriSink(): NotificationSink {
  const plugin = import("@tauri-apps/plugin-notification");
  return {
    permission: async () => ((await (await plugin).isPermissionGranted()) ? "granted" : "default"),
    requestPermission: async () => {
      const answer = await (await plugin).requestPermission();
      return answer === "granted" || answer === "denied" ? answer : "default";
    },
    show: ({ paneId, title, body }) => {
      void plugin
        .then(({ sendNotification }) => sendNotification({ title, body, extra: { paneId } }))
        .catch((error: unknown) => reportNativeCommandError("native.notificationFailed", error));
    },
    onActivate: (listener) => {
      let stop: (() => void) | null = null;
      let cancelled = false;
      void plugin
        .then(({ onAction }) =>
          onAction((event) => {
            const paneId = event.notification?.data?.paneId;
            if (typeof paneId === "string") listener(paneId);
          }),
        )
        .then((handle) => {
          if (cancelled) void handle.unregister();
          else stop = () => void handle.unregister();
        })
        .catch((error: unknown) => {
          if (!cancelled) reportNativeCommandError("native.notificationFailed", error);
        });
      return () => {
        cancelled = true;
        stop?.();
      };
    },
  };
}

function browserSink(): NotificationSink {
  const listeners = new Set<(paneId: PaneId) => void>();
  const current = (): NotificationPermission => Notification.permission;
  return {
    permission: async () => current(),
    requestPermission: async () => Notification.requestPermission(),
    show: ({ paneId, title, body }) => {
      if (current() !== "granted") return;
      const shown = new Notification(title, { body, tag: paneId });
      shown.onclick = () => {
        window.focus();
        for (const listener of listeners) listener(paneId);
        shown.close();
      };
    },
    onActivate: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export function createNotificationSink(): NotificationSink {
  if (isTauri()) return tauriSink();
  if (typeof navigator !== "undefined" && !navigator.webdriver && typeof Notification !== "undefined") {
    return browserSink();
  }
  const sink = createRecordingSink();
  if (typeof window !== "undefined") window.__tesseraNotifications = sink;
  return sink;
}
