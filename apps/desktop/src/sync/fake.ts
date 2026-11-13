// In-memory sync for the browser dev server and the UI tests. Sign-in completes on the second poll; the recovery key
// is fixed so tests can type it.
import type { SyncClient, SyncDeviceCode, SyncReport, SyncSignInPoll, SyncStatus } from "./client";

export const FAKE_RECOVERY_KEY = "ABCD-EFGH-JKMN-PQRS-TVWX-YZ01";

export class FakeSyncClient implements SyncClient {
  signedIn = false;
  hasKey = false;
  remoteData = false;
  docs = ["settings", "agent-profiles", "projects"];
  lastSyncAt: number | null = null;
  polls = 0;
  deleted = false;

  async status(): Promise<SyncStatus> {
    return {
      signed_in: this.signedIn,
      has_key: this.hasKey,
      user_id: this.signedIn ? "fake-user" : null,
      docs: [...this.docs],
      available: ["settings", "agent-profiles", "projects"],
      last_sync_at: this.lastSyncAt,
      last_error: null,
      server: "https://sync.example",
    };
  }
  async signInStart(): Promise<SyncDeviceCode> {
    this.polls = 0;
    return {
      device_code: "dev",
      user_code: "WDJB-MJHT",
      verification_uri: "https://github.com/login/device",
      expires_in: 900,
      interval: 0,
    };
  }
  async signInPoll(): Promise<SyncSignInPoll> {
    this.polls += 1;
    if (this.polls < 2) return { state: "pending", interval: 0, message: null, has_remote_data: false };
    this.signedIn = true;
    return { state: "signed_in", interval: 0, message: null, has_remote_data: this.remoteData };
  }
  async recoveryCreate() {
    this.hasKey = true;
    return FAKE_RECOVERY_KEY;
  }
  async recoveryEnter(key: string) {
    if (key.replace(/[\s-]/g, "").toUpperCase() !== FAKE_RECOVERY_KEY.replace(/-/g, "")) {
      throw Object.assign(new Error("The synced data could not be decrypted with this recovery key."), {
        code: "sync.recovery_key",
      });
    }
    this.hasKey = true;
  }
  async setDocs(docs: string[]) {
    this.docs = docs;
  }
  async syncNow(): Promise<SyncReport> {
    this.lastSyncAt = Date.now();
    return { uploaded: [...this.docs], applied: [], at: this.lastSyncAt };
  }
  async signOut() {
    this.signedIn = false;
    this.hasKey = false;
  }
  async deleteAll() {
    this.deleted = true;
    this.signedIn = false;
    this.hasKey = false;
  }
}
