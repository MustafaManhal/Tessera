import { invoke } from "@tauri-apps/api/core";
import { IpcError } from "@tessera/ipc";

export type WindowEffect = "none" | "blur";

export interface WindowEffectCommands {
  set(kind: WindowEffect): Promise<void>;
}

const nativeCommands: WindowEffectCommands = {
  async set(kind) {
    try {
      await invoke("window_set_effect", { kind });
    } catch (error) {
      throw IpcError.from(error);
    }
  },
};

export function createWindowEffectClient(commands: WindowEffectCommands = nativeCommands): WindowEffectCommands {
  return commands;
}

export function isWindowEffectUnsupported(error: unknown): boolean {
  return error instanceof IpcError && error.code === "window.effect_unsupported";
}
