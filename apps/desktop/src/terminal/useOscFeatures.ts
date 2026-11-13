// What a pane does with the OSC sequences programs print for the user (M1.5):
// - OSC 9, 99 (kitty) and 777;notify → the NotificationService (toast when looked at, OS notification otherwise).
// - OSC 9;4 progress → the tab's progress ring and the window's ProgressSink; cleared 30 s after the last update.
// - OSC 9;9 (ConEmu cwd) → the cwd, through the same host filter as OSC 7.
// - OSC 52 → clipboard writes by `terminal.osc52_write` (ask: the pane shows Osc52Confirm), never reads; 1 MiB cap.
import {
  createKittyNotifications,
  decideOsc52,
  type NotificationRequest,
  parseOsc9,
  parseOsc52,
  parseOsc777,
  type ProgressRequest,
  type TerminalEngine,
} from "@tessera/term";
import { t, useToast } from "@tessera/ui";
import { type RefObject, useCallback, useEffect, useRef, useState } from "react";
import type { PaneId } from "../layout";
import { notifications } from "../notify";
import { setProgress } from "../store/attentionSlice";
import { useAppDispatch } from "../store/hooks";
import { setTerminal, type TerminalSettings } from "../store/settingsSlice";
import { announce } from "../store/uiSlice";
import type { Osc52Choice } from "./Osc52Confirm";
import type { AgentObservation } from "../agents/types";

/** A progress report with no update for this long is cleared (a program that died mid-way). */
export const PROGRESS_TIMEOUT_MS = 30_000;

export interface OscFeatures {
  /** Characters a program asked to copy, waiting for the user (OSC 52 "ask"). */
  pendingCopy: number | null;
  answerCopy(choice: Osc52Choice): void;
}

/** OSC 9;4 names → the engine's numeric codes (iTerm2 semantics). */
function progressStateCode(state: string): number {
  switch (state) {
    case "error":
      return 2;
    case "indeterminate":
      return 3;
    case "paused":
      return 4;
    default:
      return 1;
  }
}

export function useOscFeatures(
  engine: TerminalEngine | null,
  paneId: PaneId,
  settings: RefObject<TerminalSettings>,
  cwd: { onChange: (path: string) => void },
  /** Agent panes forward OSC notifications/progress to the status engine. */
  onObservation?: (observation: AgentObservation) => void,
): OscFeatures {
  const dispatch = useAppDispatch();
  const { toast } = useToast();
  const [pendingCopy, setPendingCopy] = useState<string | null>(null);
  const cwdRef = useRef(cwd);
  cwdRef.current = cwd;

  const copy = useCallback(
    (text: string) => {
      void navigator.clipboard
        .writeText(text)
        .then(() => dispatch(announce(t("osc52.copied", { count: text.length }))))
        .catch(() => {});
    },
    [dispatch],
  );

  useEffect(() => {
    if (!engine) return;
    const kitty = createKittyNotifications();
    let progressTimer: ReturnType<typeof setTimeout> | null = null;
    let warnedRead = false;

    const notify = (request: NotificationRequest) => {
      onObservation?.({ kind: "osc_notification", text: request.body || request.title });
      notifications().notify({
        paneId,
        title: request.title,
        body: request.body,
        occasion: request.occasion,
        badge: "notification",
        source: "program",
      });
    };

    const progress = (request: ProgressRequest) => {
      if (progressTimer) clearTimeout(progressTimer);
      progressTimer = null;
      if (request.kind === "clear") {
        onObservation?.({ kind: "osc_progress", state: 0, value: null });
        dispatch(setProgress({ paneId, progress: null }));
        return;
      }
      onObservation?.({ kind: "osc_progress", state: progressStateCode(request.state), value: request.value });
      dispatch(setProgress({ paneId, progress: { state: request.state, value: request.value } }));
      progressTimer = setTimeout(() => dispatch(setProgress({ paneId, progress: null })), PROGRESS_TIMEOUT_MS);
    };

    const subscriptions = [
      engine.onOsc(9, (data) => {
        const result = parseOsc9(data);
        if (result?.kind === "notify") notify(result.request);
        else if (result?.kind === "progress") progress(result.request);
        else if (result?.kind === "cwd") cwdRef.current.onChange(result.path); // ConEmu: always this machine
        return true;
      }),
      engine.onOsc(777, (data) => {
        const request = parseOsc777(data);
        if (request) notify(request);
        return true;
      }),
      engine.onOsc(99, (data) => {
        const request = kitty.feed(data);
        if (request) notify(request);
        return true;
      }),
      engine.onOsc(52, (data) => {
        const request = parseOsc52(data);
        if (request.kind === "read") {
          // Never answered. Say so once per pane, so a program that hangs waiting for the answer makes sense.
          if (!warnedRead) toast({ title: t("osc52.readBlocked") });
          warnedRead = true;
          return true;
        }
        if (request.kind === "tooLarge") {
          toast({ kind: "error", title: t("osc52.tooLarge") });
          return true;
        }
        const decision = decideOsc52(request, settings.current.osc52Write);
        if (request.kind === "write" && decision === "write") copy(request.text);
        else if (request.kind === "write" && decision === "ask") setPendingCopy(request.text);
        return true;
      }),
    ];
    return () => {
      for (const subscription of subscriptions) subscription.dispose();
      if (progressTimer) clearTimeout(progressTimer);
      dispatch(setProgress({ paneId, progress: null }));
    };
  }, [engine, paneId, dispatch, toast, copy, settings, onObservation]);

  const answerCopy = useCallback(
    (choice: Osc52Choice) => {
      const text = pendingCopy;
      setPendingCopy(null);
      if (choice === "always") dispatch(setTerminal({ osc52Write: "allow" }));
      if (text !== null && choice !== "deny") copy(text);
      engine?.focus();
    },
    [pendingCopy, dispatch, copy, engine],
  );

  return { pendingCopy: pendingCopy === null ? null : pendingCopy.length, answerCopy };
}
