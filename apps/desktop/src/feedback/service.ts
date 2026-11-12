import { isNativeRuntime } from "../native/runtime";
import type { FeedbackClient } from "./client";
import { FakeFeedbackClient } from "./fake";
import { TauriFeedbackClient } from "./tauri";

declare global {
  interface Window {
    __tesseraFeedback?: FakeFeedbackClient;
  }
}

let current: FeedbackClient | null = null;

export function setFeedbackClient(client: FeedbackClient | null): void {
  current = client;
}

export function feedbackClient(): FeedbackClient {
  if (!current) throw new Error("No FeedbackClient: call setFeedbackClient first.");
  return current;
}

export function createFeedbackClient(search: string = window.location.search): FeedbackClient {
  const params = new URLSearchParams(search);
  if (isNativeRuntime() && params.get("feedback") !== "fake") return new TauriFeedbackClient();
  const fake = new FakeFeedbackClient();
  if (import.meta.env.DEV) window.__tesseraFeedback = fake;
  return fake;
}
