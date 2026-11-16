import { commands, events, unwrap } from "@tessera/ipc";
import type { UpdatesClient } from "./client";
import type { Channel, UpdateInfo, UpdateSettings } from "./types";

async function call<T>(promise: Promise<{ status: "ok"; data: T } | { status: "error"; error: unknown }>): Promise<T> {
  try {
    return await unwrap(promise as never);
  } catch (cause) {
    const error = cause as { message?: string };
    throw new Error(error?.message || String(cause));
  }
}

export class TauriUpdatesClient implements UpdatesClient {
  settings() {
    return call(commands.updateSettings()) as Promise<UpdateSettings>;
  }
  setSettings(channel: Channel, autoCheck: boolean) {
    return call(commands.updateSettingsSet(channel, autoCheck)) as Promise<UpdateSettings>;
  }
  check() {
    return call(commands.updateCheck()) as Promise<UpdateInfo | null>;
  }
  pending() {
    return call(commands.updatePending()) as Promise<UpdateInfo | null>;
  }
  async install() {
    await call(commands.updateInstall());
  }
  async relaunch() {
    await commands.appRelaunch();
  }
  onAvailable(listener: (info: UpdateInfo) => void) {
    const pending = events.updateAvailable.listen((event) => listener(event.payload));
    return () => void pending.then((stop) => stop());
  }
  onProgress(listener: Parameters<UpdatesClient["onProgress"]>[0]) {
    const pending = events.updateProgress.listen((event) => listener(event.payload));
    return () => void pending.then((stop) => stop());
  }
}
