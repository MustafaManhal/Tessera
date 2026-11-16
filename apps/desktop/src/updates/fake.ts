import type { UpdatesClient } from "./client";
import type { Channel, UpdateInfo, UpdateProgress, UpdateSettings } from "./types";

/** In-memory updates client for the browser and the UI tests (`window.__tesseraUpdates`). */
export class FakeUpdatesClient implements UpdatesClient {
  private state: UpdateSettings = { channel: "stable", auto_check: true, last_checked: null };
  private found: UpdateInfo | null = null;
  private available = new Set<(info: UpdateInfo) => void>();
  private progress = new Set<(progress: UpdateProgress) => void>();
  /** What the next check finds (null = up to date). */
  next: UpdateInfo | null = null;
  failCheck: string | null = null;
  failInstall: string | null = null;
  relaunched = false;
  checks = 0;

  async settings() {
    return { ...this.state };
  }
  async setSettings(channel: Channel, autoCheck: boolean) {
    if (channel !== this.state.channel) this.found = null;
    this.state = { ...this.state, channel, auto_check: autoCheck };
    return { ...this.state };
  }
  async check() {
    this.checks += 1;
    if (this.failCheck) throw new Error(this.failCheck);
    this.state = { ...this.state, last_checked: Math.floor(Date.now() / 1000) };
    this.found = this.next;
    return this.found;
  }
  async pending() {
    return this.found;
  }
  async install() {
    if (!this.found) throw new Error("There is no update to install. Check for updates first.");
    if (this.failInstall) throw new Error(this.failInstall);
    for (const listener of this.progress) listener({ downloaded: 50, total: 100, done: false });
    for (const listener of this.progress) listener({ downloaded: 100, total: 100, done: false });
    for (const listener of this.progress) listener({ downloaded: 0, total: null, done: true });
    this.found = null;
  }
  async relaunch() {
    this.relaunched = true;
  }
  /** Test helper: the background checker found something. */
  announce(info: UpdateInfo) {
    this.found = info;
    for (const listener of this.available) listener(info);
  }
  onAvailable(listener: (info: UpdateInfo) => void) {
    this.available.add(listener);
    return () => void this.available.delete(listener);
  }
  onProgress(listener: (progress: UpdateProgress) => void) {
    this.progress.add(listener);
    return () => void this.progress.delete(listener);
  }
}
