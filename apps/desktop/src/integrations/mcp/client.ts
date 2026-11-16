import { commands, unwrap } from "@tessera/ipc";
import { isNativeRuntime } from "../../native/runtime";
export interface Server {
  id: string;
  name: string;
  transport: "stdio" | "http";
  command: string;
  args: string[];
  url: string;
  env_keys: string[];
}
export interface Skill {
  id: string;
  name: string;
  kind: "agents_md" | "claude_skill" | "rules_file";
  body: string;
  install_targets: string[];
}
export interface Install {
  mcp_server_id: string;
  agent_id: string;
  config_path: string;
}
export interface Data {
  servers: Server[];
  skills: Skill[];
  installs: Install[];
  agents: { id: string; name: string; manual: boolean }[];
  tasks: { id: string; name: string; remote: boolean }[];
}
export interface Preview {
  token?: string;
  path?: string;
  preview: string;
  manual?: boolean;
}
export interface Target {
  id: string;
  target: string;
  agent: string;
  remove: boolean;
  write_values: boolean;
}
export interface ManagerClient {
  list(): Promise<Data>;
  saveServer(server: Server, values: Record<string, string>): Promise<Server>;
  deleteServer(id: string): Promise<void>;
  test(id: string): Promise<{ tools: string[] }>;
  saveSkill(skill: Skill): Promise<Skill>;
  deleteSkill(id: string): Promise<void>;
  preview(kind: "server" | "skill", target: Target): Promise<Preview>;
  apply(token: string): Promise<{ backup: string }>;
}
class TauriManager implements ManagerClient {
  private async call<T>(operation: string, input: unknown = {}): Promise<T> {
    return JSON.parse(await unwrap(commands.managerCall(operation, JSON.stringify(input)))) as T;
  }
  list() {
    return this.call<Data>("list");
  }
  saveServer(server: Server, values: Record<string, string>) {
    return this.call<Server>("save_server", { server, values });
  }
  deleteServer(id: string) {
    return this.call<void>("delete_server", { id });
  }
  test(id: string) {
    return this.call<{ tools: string[] }>("test", { id });
  }
  saveSkill(skill: Skill) {
    return this.call<Skill>("save_skill", skill);
  }
  deleteSkill(id: string) {
    return this.call<void>("delete_skill", { id });
  }
  preview(kind: "server" | "skill", target: Target) {
    return this.call<Preview>(`preview_${kind}`, target);
  }
  apply(token: string) {
    return this.call<{ backup: string }>("apply", { token });
  }
}
export class FakeManager implements ManagerClient {
  data: Data = {
    servers: [],
    skills: [],
    installs: [],
    agents: [
      { id: "claude", name: "Claude Code", manual: false },
      { id: "codex", name: "Codex", manual: false },
      { id: "gemini", name: "Gemini CLI", manual: false },
      { id: "opencode", name: "OpenCode", manual: false },
      { id: "cursor-agent", name: "Cursor Agent", manual: true },
    ],
    tasks: [
      { id: "local", name: "Local fixture", remote: false },
      { id: "remote", name: "Remote fixture", remote: true },
    ],
  };
  private serial = 0;
  private plans = new Map<string, { kind: "server" | "skill"; target: Target; path: string }>();
  private secrets = new Map<string, Record<string, string>>();
  failList = false;
  failTest = false;
  failApply = false;
  delay = 0;
  calls: { method: string; id?: string }[] = [];
  async list() {
    if (this.delay) await new Promise((r) => setTimeout(r, this.delay));
    if (this.failList) throw Error("Fixture manager unavailable.");
    return structuredClone(this.data);
  }
  private valid(name: string) {
    if (!/^[a-zA-Z0-9_-]{1,80}$/.test(name)) throw Error("Use a name with letters, numbers, hyphens or underscores.");
  }
  async saveServer(server: Server, values: Record<string, string>) {
    this.valid(server.name);
    if (server.transport === "stdio" && !server.command.trim()) throw Error("A stdio command is required.");
    if (server.transport === "http" && !/^https?:\/\//.test(server.url))
      throw Error("Use an absolute HTTP or HTTPS URL.");
    if (this.data.servers.some((s) => s.id !== server.id && s.name === server.name))
      throw Error("Server name must be unique.");
    const row = structuredClone({ ...server, id: server.id || `server-${++this.serial}` });
    this.data.servers = this.data.servers.filter((s) => s.id !== row.id).concat(row);
    const old = this.secrets.get(row.id) ?? {};
    const next = { ...old, ...values };
    for (const key of Object.keys(next)) if (!row.env_keys.includes(key) || !next[key]) delete next[key];
    this.secrets.set(row.id, next);
    this.calls.push({ method: "save_server", id: row.id });
    return row;
  }
  async deleteServer(id: string) {
    if (this.data.installs.some((i) => i.mcp_server_id === id))
      throw Error("Uninstall this server before deleting it.");
    this.data.servers = this.data.servers.filter((s) => s.id !== id);
    this.secrets.delete(id);
    this.calls.push({ method: "delete_server", id });
  }
  async test(id: string) {
    this.calls.push({ method: "test", id });
    if (this.failTest) throw Error("The MCP test timed out or the server closed stdout.");
    return { tools: ["search_fixture", "read_fixture"] };
  }
  async saveSkill(skill: Skill) {
    this.valid(skill.name);
    if (!skill.body.trim()) throw Error("Write some Markdown.");
    const old = this.data.skills.find((s) => s.id === skill.id);
    if (old?.install_targets.length && (old.name !== skill.name || old.kind !== skill.kind))
      throw Error("Uninstall the skill before changing its name or kind.");
    const row = structuredClone({
      ...skill,
      id: skill.id || `skill-${++this.serial}`,
      install_targets: old?.install_targets ?? [],
    });
    this.data.skills = this.data.skills.filter((s) => s.id !== row.id).concat(row);
    this.calls.push({ method: "save_skill", id: row.id });
    return row;
  }
  async deleteSkill(id: string) {
    if (this.data.skills.some((s) => s.id === id && s.install_targets.length))
      throw Error("Uninstall this skill before deleting it.");
    this.data.skills = this.data.skills.filter((s) => s.id !== id);
    this.calls.push({ method: "delete_skill", id });
  }
  async preview(kind: "server" | "skill", target: Target) {
    this.calls.push({ method: `preview_${kind}`, id: target.id });
    if (this.data.tasks.some((t) => t.id === target.target && t.remote))
      throw Error("Remote worktree installs are not supported yet.");
    const row =
      kind === "server"
        ? this.data.servers.find((s) => s.id === target.id)
        : this.data.skills.find((s) => s.id === target.id);
    if (!row) throw Error("Definition not found.");
    if (
      kind === "server" &&
      (this.data.agents.some((a) => a.id === target.agent && a.manual) ||
        (target.agent === "codex" && target.target !== "home"))
    )
      return {
        manual: true,
        preview: JSON.stringify(
          {
            mcpServers: {
              [row.name]:
                (row as Server).transport === "http"
                  ? { type: "http", url: (row as Server).url }
                  : { command: (row as Server).command, args: (row as Server).args },
            },
          },
          null,
          2,
        ),
      };
    const path =
      kind === "server" ? `/fixture/${target.target}/${target.agent}.json` : `/fixture/${target.target}/${row.name}.md`;
    const token = `plan-${++this.serial}`;
    this.plans.set(token, { kind, target: structuredClone(target), path });
    return {
      token,
      path,
      preview: target.remove
        ? `Remove only tessera:${row.id}`
        : kind === "skill"
          ? (row as Skill).body
          : JSON.stringify(
              {
                name: row.name,
                marker: `tessera:${row.id}`,
                env: (row as Server).env_keys,
                values: target.write_values ? "<redacted>" : "reference by name",
              },
              null,
              2,
            ),
    };
  }
  async apply(token: string) {
    if (this.failApply) throw Error("The target changed after preview. Preview it again.");
    const plan = this.plans.get(token);
    if (!plan) throw Error("Preview expired.");
    this.plans.delete(token);
    const { kind, target, path } = plan;
    if (kind === "server") {
      this.data.installs = this.data.installs.filter(
        (i) => !(i.mcp_server_id === target.id && i.agent_id === target.agent && i.config_path === path),
      );
      if (!target.remove)
        this.data.installs.push({ mcp_server_id: target.id, agent_id: target.agent, config_path: path });
    } else {
      const row = this.data.skills.find((s) => s.id === target.id);
      if (row) {
        row.install_targets = row.install_targets.filter((p) => p !== path);
        if (!target.remove) row.install_targets.push(path);
      }
    }
    this.calls.push({ method: target.remove ? "uninstall" : "install", id: target.id });
    return { backup: `${path}.tessera.bak-fixture` };
  }
}
declare global {
  interface Window {
    __tesseraManager?: FakeManager;
  }
}
const fake = new FakeManager();
if (typeof window !== "undefined" && import.meta.env.DEV && !isNativeRuntime()) window.__tesseraManager = fake;
const native = new TauriManager();
export function managerClient(): ManagerClient {
  return isNativeRuntime() ? native : fake;
}
