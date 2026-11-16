// SyncClient: the sync commands (Rust `sync_commands.rs`, M11.2) behind one interface; a fake for browser and tests.
export interface SyncStatus {
  signed_in: boolean;
  has_key: boolean;
  user_id: string | null;
  docs: string[];
  available: string[];
  last_sync_at: number | null;
  last_error: string | null;
  server: string;
}

export interface SyncDeviceCode {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
}

export interface SyncSignInPoll {
  state: "pending" | "slow_down" | "signed_in" | "failed";
  interval: number;
  message: string | null;
  has_remote_data: boolean;
}

export interface SyncReport {
  uploaded: string[];
  applied: string[];
  at: number;
}

export interface SyncClient {
  status(): Promise<SyncStatus>;
  signInStart(): Promise<SyncDeviceCode>;
  signInPoll(deviceCode: string): Promise<SyncSignInPoll>;
  /** New account: a recovery key shown once. */
  recoveryCreate(): Promise<string>;
  /** Existing data: the saved recovery key, checked before it is kept. */
  recoveryEnter(recoveryKey: string): Promise<void>;
  setDocs(docs: string[]): Promise<void>;
  syncNow(): Promise<SyncReport>;
  signOut(): Promise<void>;
  deleteAll(): Promise<void>;
}
