// TauriSyncClient: the generated bindings (`sync_commands.rs`).
import { type AppError_Serialize, commands, type CommandResult, unwrap } from "@tessera/ipc";
import type { SyncClient, SyncDeviceCode, SyncReport, SyncSignInPoll, SyncStatus } from "./client";

const call = <T>(result: Promise<CommandResult<T, AppError_Serialize>>) => unwrap(result);

export class TauriSyncClient implements SyncClient {
  status() {
    return call(commands.syncStatus()) as Promise<SyncStatus>;
  }
  signInStart() {
    return call(commands.syncSignInStart()) as Promise<SyncDeviceCode>;
  }
  signInPoll(deviceCode: string) {
    return call(commands.syncSignInPoll(deviceCode)) as Promise<SyncSignInPoll>;
  }
  recoveryCreate() {
    return call(commands.syncRecoveryCreate());
  }
  async recoveryEnter(recoveryKey: string) {
    await call(commands.syncRecoveryEnter(recoveryKey));
  }
  async setDocs(docs: string[]) {
    await call(commands.syncSetDocs(docs));
  }
  syncNow() {
    return call(commands.syncNow()) as Promise<SyncReport>;
  }
  async signOut() {
    await call(commands.syncSignOut());
  }
  async deleteAll() {
    await call(commands.syncDeleteAll());
  }
}
