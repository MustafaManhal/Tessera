// In-memory SSH hosts for the browser dev server and the UI tests: two config hosts and one manual host. The plan's
// program is the fake shell, so a connect opens a working pane in the browser.
import type { SshClient } from "./client";
import type { SshHostInfo, SshHostInput, SshLaunch } from "./types";

const seed = (): SshHostInfo[] => [
  {
    id: "config:build",
    alias: "build",
    host: "build.internal",
    port: null,
    user: "deploy",
    auth: "key",
    key_path: "~/.ssh/id_ed25519",
    proxy_jump: null,
    source: "config",
    password_saved: false,
  },
  {
    id: "config:db",
    alias: "db",
    host: "10.0.0.5",
    port: 2222,
    user: null,
    auth: "agent",
    key_path: null,
    proxy_jump: "build",
    source: "config",
    password_saved: false,
  },
  {
    id: "m1",
    alias: "lab",
    host: "lab.example.com",
    port: null,
    user: "me",
    auth: "password",
    key_path: null,
    proxy_jump: null,
    source: "manual",
    password_saved: true,
  },
];

export class FakeSshClient implements SshClient {
  hosts: SshHostInfo[] = seed();
  passwords = new Map<string, string>([["lab", "fixture"]]);
  plans: string[] = [];
  private next = 2;

  async list() {
    return structuredClone(this.hosts);
  }

  async save(input: SshHostInput) {
    const alias = input.alias.trim();
    if (!alias || /\s/.test(alias))
      throw Object.assign(new Error("Give the host a name without spaces."), { code: "ssh.invalid" });
    if (!input.host.trim()) throw Object.assign(new Error("Enter the host name or address."), { code: "ssh.invalid" });
    const existing = this.hosts.find((h) => h.id === input.id || (input.id === null && h.alias === alias));
    if (input.id === null && existing) {
      throw Object.assign(new Error(`A host named ${alias} already exists.`), { code: "ssh.duplicate" });
    }
    const host: SshHostInfo = {
      id: existing?.id.startsWith("config:") ? `m${this.next++}` : (existing?.id ?? `m${this.next++}`),
      alias,
      host: input.host.trim(),
      port: input.port,
      user: input.user?.trim() || null,
      auth: input.auth,
      key_path: input.key_path?.trim() || null,
      proxy_jump: existing?.proxy_jump ?? null,
      source: existing?.source ?? "manual",
      password_saved: existing?.password_saved ?? false,
    };
    this.hosts = existing ? this.hosts.map((h) => (h === existing ? host : h)) : [...this.hosts, host];
    return structuredClone(host);
  }

  async remove(id: string) {
    const host = this.hosts.find((h) => h.id === id);
    if (!host) return;
    this.passwords.delete(host.alias);
    this.hosts =
      host.source === "config"
        ? this.hosts.map((h) => (h === host ? { ...h, id: `config:${h.alias}`, password_saved: false } : h))
        : this.hosts.filter((h) => h !== host);
  }

  async savePassword(alias: string, password: string) {
    if (!password) throw Object.assign(new Error("Enter the password to save."), { code: "ssh.invalid" });
    this.passwords.set(alias, password);
    this.hosts = this.hosts.map((h) => (h.alias === alias ? { ...h, password_saved: true } : h));
  }

  async forgetPassword(alias: string) {
    this.passwords.delete(alias);
    this.hosts = this.hosts.map((h) => (h.alias === alias ? { ...h, password_saved: false } : h));
  }

  async connectPlan(id: string): Promise<SshLaunch> {
    const host = this.hosts.find((h) => h.id === id);
    if (!host) throw Object.assign(new Error("That host is no longer in the list."), { code: "ssh.unknown" });
    this.plans.push(host.alias);
    return { program: "ssh", args: [host.alias], env: {}, title: host.alias, notice: null };
  }
}
