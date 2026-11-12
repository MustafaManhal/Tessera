import { isNativeRuntime } from "../native/runtime";
import type { BoardClient } from "./client";
import { FakeBoardClient } from "./fake";
import { TauriBoardClient } from "./tauri";

declare global {
  interface Window {
    __tesseraBoard?: FakeBoardClient;
  }
}

let current: BoardClient | null = null;

export function setBoardClient(client: BoardClient | null): void {
  current = client;
}

export function boardClient(): BoardClient {
  if (!current) throw new Error("No BoardClient: call setBoardClient first.");
  return current;
}

export function createBoardClient(search: string = window.location.search): BoardClient {
  const params = new URLSearchParams(search);
  if (isNativeRuntime() && params.get("board") !== "fake") return new TauriBoardClient();
  const fake = new FakeBoardClient();
  if (import.meta.env.DEV) window.__tesseraBoard = fake;
  return fake;
}
