// NotificationService (FR-10, FR-18): the one place panes send "look at this" to.
// - Looking at the pane (window focused, pane focused and on screen): an in-app toast, never an OS notification.
// - Otherwise: an OS notification through the NotificationSink, titled with the pane's title as the source, and a
//   badge on the pane's tab until the pane is focused again.
// - At most one per pane per 5 s; what comes in between is folded into one (throttle.ts).
// - Permission: the first time one would be shown while the permission is undecided, the explanation dialog asks
//   (NotificationHost); "Not now" keeps notifications in the app for this session.
// - Clicking a notification focuses its pane.
import { t, type ToastOptions } from "@tessera/ui";
import { isPaneVisible, type LayoutState, type PaneId, paneTitle } from "../layout";
import type { NotificationSink, OsNotification } from "../native/notifications";
import type { AppDispatch, RootState } from "../store";
import { type BadgeKind, setBadge } from "../store/attentionSlice";
import { layout } from "../store/layoutSlice";
import { bumpInbox, requestPaneFocus, setNotificationPrompt } from "../store/uiSlice";
import { configValue, isDndActive } from "../agents/attention";
import { inbox } from "./inbox";
import { createThrottle, type Throttle } from "./throttle";

export const NOTIFY_INTERVAL_MS = 5000;
/** Notifications kept while the permission dialog is open. */
const WAITING_MAX = 5;

export interface PaneNotice {
  paneId: PaneId;
  /** The program's title, or "" (the pane title is the source either way). */
  title: string;
  body: string;
  /** kitty `o`: "unfocused" or "invisible" show nothing while the pane is looked at. */
  occasion?: "always" | "unfocused" | "invisible";
  badge: BadgeKind;
  /** Program notifications follow `notifications.enabled`; long-command alerts have their own switch;
   * agent attention was already gated by the notifications.agent-* settings before it got here. */
  source: "program" | "longCommand" | "agent";
}

export interface NotificationServiceDeps {
  sink: NotificationSink;
  getState: () => RootState;
  dispatch: AppDispatch;
  focusWindow: () => void | Promise<void>;
  now?: () => number;
  setTimer?: (run: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

/** The user is looking at this pane right now. */
export function isPaneLookedAt(state: RootState, paneId: PaneId): boolean {
  if (!state.ui.windowFocused) return false;
  const tab = state.layout.tabs.find((candidate) => candidate.id === state.layout.activeTab);
  return tab?.focusedPane === paneId && isPaneVisible(state.layout, paneId);
}

function sourceTitle(state: LayoutState, paneId: PaneId): string {
  return paneTitle(state.panes[paneId]) ?? t("tab.untitled");
}

export class NotificationService {
  private toaster: ((options: ToastOptions) => void) | null = null;
  private readonly throttle: Throttle<PaneNotice>;
  private asked = false;
  private waiting: OsNotification[] = [];
  private readonly stopActivate: () => void;

  constructor(private readonly deps: NotificationServiceDeps) {
    this.throttle = createThrottle<PaneNotice>({
      intervalMs: NOTIFY_INTERVAL_MS,
      now: deps.now ?? Date.now,
      setTimer: deps.setTimer ?? ((run, ms) => setTimeout(run, ms)),
      clearTimer: deps.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>)),
      send: (_key, notice, count) => this.deliver(notice, count),
    });
    this.stopActivate = deps.sink.onActivate((paneId) => {
      void this.focusPane(paneId).catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        if (this.toaster) this.toaster({ kind: "error", title: t("native.focusFailed", { message }) });
        else console.error("Could not focus the main window from a notification:", error);
      });
    });
  }

  /** NotificationHost hands over the toast function (null when it unmounts). */
  setToaster(toaster: ((options: ToastOptions) => void) | null): void {
    this.toaster = toaster;
  }

  /** A toast in the window (success of an action, an error), without an OS notification. */
  toastNow(options: ToastOptions): void {
    this.toaster?.(options);
  }

  notify(notice: PaneNotice): void {
    const state = this.deps.getState();
    if (notice.source === "program" && !state.settings.terminal.notifications) return;
    if (!state.layout.panes[notice.paneId]) return;
    const lookedAt = isPaneLookedAt(state, notice.paneId);
    if (lookedAt && (notice.occasion === "unfocused" || notice.occasion === "invisible")) return;
    if (!lookedAt) {
      this.deps.dispatch(setBadge({ paneId: notice.paneId, badge: { kind: notice.badge, text: notice.body } }));
    }
    // DND suppresses only the OS notification (and its sound); the badge above and the inbox row still count.
    if (
      notice.source === "agent" &&
      isDndActive(configValue(state.config.values, "notifications.dnd-until"), Math.floor(Date.now() / 1000))
    ) {
      this.toast({ paneId: notice.paneId, title: sourceTitle(state.layout, notice.paneId), body: notice.body });
      return;
    }
    this.throttle.offer(notice.paneId, notice);
  }

  /** The explanation dialog's answer. */
  async answerPrompt(allow: boolean): Promise<void> {
    this.asked = true;
    this.deps.dispatch(setNotificationPrompt(false));
    const waiting = this.waiting;
    this.waiting = [];
    const granted = allow && (await this.deps.sink.requestPermission()) === "granted";
    for (const notification of waiting) {
      if (granted) this.deps.sink.show(notification);
      else this.toast(notification);
    }
  }

  async focusPane(paneId: PaneId): Promise<void> {
    if (!this.deps.getState().layout.panes[paneId]) return;
    await this.deps.focusWindow();
    this.deps.dispatch(layout({ type: "pane/focus", paneId }));
    this.deps.dispatch(requestPaneFocus());
  }

  forgetPane(paneId: PaneId): void {
    this.throttle.forget(paneId);
  }

  dispose(): void {
    this.throttle.dispose();
    this.stopActivate();
  }

  private deliver(notice: PaneNotice, count: number): void {
    const state = this.deps.getState();
    if (!state.layout.panes[notice.paneId]) return;
    const source = sourceTitle(state.layout, notice.paneId);
    const more = count > 1 ? ` ${t("notify.more", { count: count - 1 })}` : "";
    const notification: OsNotification = {
      paneId: notice.paneId,
      title: notice.title ? `${notice.title} · ${source}` : source,
      body: `${notice.body}${more}`.trim(),
    };
    // Long-command alerts are attention events too: they land in the S-16 inbox (agent rows are recorded by
    // the attention engine, which knows the task and session ids).
    if (notice.source === "longCommand") {
      const taskId = state.layout.panes[notice.paneId]?.taskId ?? null;
      this.deps.dispatch(bumpInbox());
      void inbox()
        .record({ source: "command", taskId, paneSessionId: null, title: source, body: notice.body })
        .catch(() => {});
    }
    if (isPaneLookedAt(state, notice.paneId)) {
      this.toast(notification);
      return;
    }
    void this.deps.sink.permission().then((permission) => {
      if (permission === "granted") this.deps.sink.show(notification);
      else if (permission === "default" && !this.asked) {
        if (this.waiting.length < WAITING_MAX) this.waiting.push(notification);
        this.deps.dispatch(setNotificationPrompt(true));
      } else this.toast(notification);
    });
  }

  private toast(notification: OsNotification): void {
    this.toaster?.({ title: notification.title, description: notification.body || undefined });
  }
}
