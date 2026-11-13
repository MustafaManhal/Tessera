// The privacy preference (FR-74): optional anonymous usage statistics, off by default. In this version the switch only
// records the choice; nothing is collected or sent. Outside the native app the value lives in memory.
import { commands, unwrap } from "@tessera/ipc";
import { isNativeRuntime } from "../native/runtime";

let memory = false;

export async function getUsageStats(): Promise<boolean> {
  if (!isNativeRuntime()) return memory;
  return (await unwrap(commands.privacySettings())).usage_stats;
}

export async function setUsageStats(enabled: boolean): Promise<boolean> {
  if (!isNativeRuntime()) {
    memory = enabled;
    return memory;
  }
  return (await unwrap(commands.privacySetUsageStats(enabled))).usage_stats;
}
