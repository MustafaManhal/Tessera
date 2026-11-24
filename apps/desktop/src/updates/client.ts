import type { Channel, UpdateInfo, UpdateProgress, UpdateSettings } from "./types";

export type Unsubscribe = () => void;

export interface UpdatesClient {
  settings(): Promise<UpdateSettings>;
  setSettings(channel: Channel, autoCheck: boolean): Promise<UpdateSettings>;
  /** Null: up to date. Throws an Error with a sentence for people. */
  check(): Promise<UpdateInfo | null>;
  pending(): Promise<UpdateInfo | null>;
  /** The update that is downloaded and waits for a restart. */
  ready(): Promise<UpdateInfo | null>;
  /** Downloads the pending update and gets it ready; a restart finishes it. */
  install(): Promise<void>;
  /** Restarts the app, finishing a downloaded update first. */
  relaunch(): Promise<void>;
  onAvailable(listener: (info: UpdateInfo) => void): Unsubscribe;
  /** An update finished downloading (in the background or from "Install"). */
  onReady(listener: (info: UpdateInfo) => void): Unsubscribe;
  onProgress(listener: (progress: UpdateProgress) => void): Unsubscribe;
}
