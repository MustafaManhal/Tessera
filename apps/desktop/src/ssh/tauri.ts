// TauriSshClient: the generated IPC bindings are the contract (`ssh_commands.rs`).
import { type AppError_Serialize, commands, type CommandResult, unwrap } from "@tessera/ipc";
import type { SshClient } from "./client";
import type { SshHostInfo, SshHostInput, SshLaunch } from "./types";

function call<T>(result: Promise<CommandResult<T, AppError_Serialize>>): Promise<T> {
  return unwrap(result);
}

export class TauriSshClient implements SshClient {
  list() {
    return call(commands.sshHostsList()) as Promise<SshHostInfo[]>;
  }
  save(input: SshHostInput) {
    return call(commands.sshHostSave(input)) as Promise<SshHostInfo>;
  }
  async remove(id: string) {
    await call(commands.sshHostDelete(id));
  }
  async savePassword(alias: string, password: string) {
    await call(commands.sshPasswordSave(alias, password));
  }
  async forgetPassword(alias: string) {
    await call(commands.sshPasswordForget(alias));
  }
  connectPlan(id: string) {
    return call(commands.sshConnectPlan(id)) as Promise<SshLaunch>;
  }
}
