// Updates (M12.2, FR-73). Mirrors the Rust DTOs.
export type Channel = "stable" | "beta";

export interface UpdateSettings {
  channel: Channel;
  auto_check: boolean;
  /** Unix seconds of the last successful check. */
  last_checked: number | null;
}

export interface UpdateInfo {
  version: string;
  current_version: string;
  notes: string | null;
  date: string | null;
}

export interface UpdateProgress {
  downloaded: number;
  total: number | null;
  done: boolean;
}
