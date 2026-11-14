// TauriCliClient: the generated IPC bindings are the command contract.
import { type AppError_Serialize, commands, type CommandResult, unwrap } from "@tessera/ipc";
import type { CliClient } from "./client";
import type { CliInstall } from "./types";

function call<T>(result: Promise<CommandResult<T, AppError_Serialize>>): Promise<T> {
  return unwrap(result);
}

export class TauriCliClient implements CliClient {
  cliInstallStatus() {
    return call(commands.cliInstallStatus()) as Promise<CliInstall>;
  }
  cliInstall() {
    return call(commands.cliInstall()) as Promise<CliInstall>;
  }
  cliUninstall() {
    return call(commands.cliUninstall()) as Promise<CliInstall>;
  }
}
