// SshClient: the SSH host commands behind one interface, like the projects and agents clients.
// - FakeSshClient (fake.ts): in memory, for the browser dev server and tests.
// - TauriSshClient (tauri.ts): the generated bindings.
import type { SshHostInfo, SshHostInput, SshLaunch } from "./types";

export interface SshClient {
  /** `~/.ssh/config` hosts first (file order), then hosts added by hand. */
  list(): Promise<SshHostInfo[]>;
  /** Adds or edits a manual host, or stores settings for a config host (id `config:<alias>`). */
  save(input: SshHostInput): Promise<SshHostInfo>;
  /** Removes a manual host or a config host's stored settings, and its saved password. */
  remove(id: string): Promise<void>;
  /** Saves the password in the OS keychain. */
  savePassword(alias: string, password: string): Promise<void>;
  forgetPassword(alias: string): Promise<void>;
  /** The `ssh` command line for a terminal on the host. */
  connectPlan(id: string): Promise<SshLaunch>;
}
