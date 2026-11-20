// Do not disturb (brief 32): `notifications.dnd-until` in config.toml. While it is in the future the OS
// notification and its sound are suppressed; in-app badges and the inbox still count.
import { store } from "../store";
import { configValue, isDndActive } from "../agents/attention";
import { createSettingsClient } from "../settings/provider";

let client: ReturnType<typeof createSettingsClient> | null = null;
function settings() {
  client ??= createSettingsClient();
  return client;
}

/** "Until I turn it off" maps to the far end of the u32 the schema accepts. */
export const DND_INDEFINITE = 4_102_444_800; // 2100-01-01

export function dndUntil(state = store.getState()): number {
  const value = configValue(state.config.values, "notifications.dnd-until");
  return typeof value === "number" ? value : 0;
}

export function dndActive(nowSeconds = Math.floor(Date.now() / 1000)): boolean {
  return isDndActive(dndUntil(), nowSeconds);
}

/** Sets the DND deadline (Unix seconds; 0 turns it off) through the settings client → config.toml. */
export async function setDndUntil(until: number): Promise<void> {
  await settings().set({ notifications: { "dnd-until": until } });
}

/** The palette/action toggle: on → 30 minutes, off → cleared. */
export async function toggleDnd(): Promise<void> {
  await setDndUntil(dndActive() ? 0 : Math.floor(Date.now() / 1000) + 30 * 60);
}
