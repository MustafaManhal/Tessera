// The SSH host contract (Rust `ssh_commands.rs`, M10.1). Field names match the generated bindings.
export type SshAuth = "agent" | "key" | "password";

export interface SshHostInfo {
  /** Saved row id, or `config:<alias>` for a `~/.ssh/config` host without stored settings. */
  id: string;
  alias: string;
  host: string;
  port: number | null;
  user: string | null;
  auth: SshAuth;
  key_path: string | null;
  proxy_jump: string | null;
  source: "config" | "manual";
  password_saved: boolean;
}

export interface SshHostInput {
  id: string | null;
  alias: string;
  host: string;
  port: number | null;
  user: string | null;
  auth: SshAuth;
  key_path: string | null;
}

export interface SshLaunch {
  program: string;
  args: string[];
  env: Record<string, string>;
  title: string;
  /** Why a saved password is not used this time (an untrusted host key). */
  notice: string | null;
}
