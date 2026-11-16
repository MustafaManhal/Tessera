import type { Channel, UpdateInfo, UpdateProgress, UpdateSettings } from "./types";

export type Unsubscribe = () => void;

export interface UpdatesClient {
  settings(): Promise<UpdateSettings>;
  setSettings(channel: Channel, autoCheck: boolean): Promise<UpdateSettings>;
  /** Null: up to date. Throws an Error with a sentence for people. */
  check(): Promise<UpdateInfo | null>;
  pending(): Promise<UpdateInfo | null>;
  install(): Promise<void>;
  relaunch(): Promise<void>;
  onAvailable(listener: (info: UpdateInfo) => void): Unsubscribe;
  onProgress(listener: (progress: UpdateProgress) => void): Unsubscribe;
}
