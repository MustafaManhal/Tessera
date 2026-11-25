// Automatic error reports from the window (see apps/desktop/src-tauri/src/reports.rs for what is collected and how it
// is sent). This side reports uncaught exceptions, rejected promises and every error toast the user sees, each with the
// last app actions before it (action types only, never their contents), and the counts of app actions every ten
// minutes. The backend redacts, queues and sends, and drops everything when Settings, Privacy turns reports off.
import { commands, type ReportInput } from "@tessera/ipc";
import type { Middleware } from "@reduxjs/toolkit";
import { isNativeRuntime } from "../native/runtime";

const CRUMBS = 100;
const USAGE_EVERY_MS = 10 * 60 * 1000;
/** Actions too frequent to say anything as breadcrumbs (they are still counted). */
const QUIET = /(\/output|\/tick|\/progress|\/observe|\/resize|\/hover|\/scroll)/i;

const crumbs: { at: number; type: string }[] = [];
let counts = new Map<string, number>();
let started = false;

function send(events: ReportInput[]): void {
  if (!isNativeRuntime() || events.length === 0) return;
  void commands.reportsRecord(events).catch(() => {});
}

/** The last app actions, oldest first, with their age in seconds. */
export function breadcrumbs(): { type: string; secondsAgo: number }[] {
  const now = Date.now();
  return crumbs.map((c) => ({ type: c.type, secondsAgo: Math.round((now - c.at) / 1000) }));
}

/** Records action types (never their payloads) for breadcrumbs and usage counts. */
export const reportingMiddleware: Middleware = () => (next) => (action) => {
  const type = (action as { type?: unknown }).type;
  if (typeof type === "string") {
    counts.set(type, (counts.get(type) ?? 0) + 1);
    if (!QUIET.test(type)) {
      crumbs.push({ at: Date.now(), type });
      if (crumbs.length > CRUMBS) crumbs.shift();
    }
  }
  return next(action);
};

/** Reports an error the window met, with the actions before it. */
export function reportError(name: string, message: string, extra: Record<string, unknown> = {}): void {
  send([
    {
      kind: "error",
      name,
      message: message.slice(0, 4000),
      data: JSON.stringify({
        ...extra,
        breadcrumbs: breadcrumbs(),
        language: navigator.language,
        visible: document.visibilityState,
      }),
    },
  ]);
}

/** Sends the action counts since the last time (usage). */
export function flushUsage(): void {
  if (counts.size === 0) return;
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 150);
  counts = new Map();
  send([{ kind: "usage", name: "actions", message: "", data: JSON.stringify(Object.fromEntries(top)) }]);
}

function stackOf(value: unknown): string | undefined {
  return value instanceof Error ? value.stack?.slice(0, 8000) : undefined;
}

/** Starts listening for uncaught errors and sends usage counts every ten minutes. */
export function startReporting(): void {
  if (started || !isNativeRuntime()) return;
  started = true;
  window.addEventListener("error", (event) => {
    reportError("exception", event.message || String(event.error), {
      stack: stackOf(event.error),
      source: event.filename ? `${event.filename}:${event.lineno}:${event.colno}` : undefined,
    });
  });
  window.addEventListener("unhandledrejection", (event) => {
    const reason = event.reason;
    reportError("unhandled_rejection", reason instanceof Error ? reason.message : String(reason), {
      stack: stackOf(reason),
      code: (reason as { code?: unknown } | null)?.code,
    });
  });
  send([
    {
      kind: "event",
      name: "window_started",
      message: "",
      data: JSON.stringify({
        language: navigator.language,
        screen: `${window.screen.width}x${window.screen.height}@${window.devicePixelRatio}`,
        userAgent: navigator.userAgent,
      }),
    },
  ]);
  window.setInterval(flushUsage, USAGE_EVERY_MS);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flushUsage();
  });
}
