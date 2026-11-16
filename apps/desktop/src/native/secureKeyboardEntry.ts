import { commands, unwrap, type SecureKeyboardState } from "@tessera/ipc";
import { getPlatform, type Platform } from "@tessera/ui";
import { isNativeRuntime } from "./runtime";

export interface SecureKeyboardCommands {
  getState(): Promise<SecureKeyboardState>;
  set(enabled: boolean): Promise<SecureKeyboardState>;
}

const pendingSets = new WeakMap<SecureKeyboardCommands, Map<boolean, Promise<boolean | null>>>();

const nativeCommands: SecureKeyboardCommands = {
  getState: () => commands.secureKeyboardEntryState(),
  set: (enabled) => unwrap(commands.secureKeyboardEntrySet(enabled)),
};

export function secureKeyboardSupported(
  platform: Platform = getPlatform(),
  isNative: boolean = isNativeRuntime(),
): boolean {
  return platform === "mac" && isNative;
}

export async function readSecureKeyboardEntry(
  client: SecureKeyboardCommands = nativeCommands,
  platform: Platform = getPlatform(),
  isNative: boolean = isNativeRuntime(),
): Promise<boolean | null> {
  if (!secureKeyboardSupported(platform, isNative)) return null;
  const state = await client.getState();
  return state.status === "supported" ? state.enabled : null;
}

export function setSecureKeyboardEntry(
  enabled: boolean,
  client: SecureKeyboardCommands = nativeCommands,
  platform: Platform = getPlatform(),
  isNative: boolean = isNativeRuntime(),
): Promise<boolean | null> {
  if (!secureKeyboardSupported(platform, isNative)) return Promise.resolve(null);
  const pending = pendingSets.get(client) ?? new Map<boolean, Promise<boolean | null>>();
  pendingSets.set(client, pending);
  const existing = pending.get(enabled);
  if (existing) return existing;
  const request = client.set(enabled).then((state) => (state.status === "supported" ? state.enabled : null));
  pending.set(enabled, request);
  const clear = () => {
    if (pending.get(enabled) === request) pending.delete(enabled);
  };
  void request.then(clear, clear);
  return request;
}
