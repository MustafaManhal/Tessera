// The default shortcut tables, one file per preset. Presets are data: the registry looks an action's defaults up here.
import type { Platform } from "@tessera/ui";
import type { ShortcutSpec } from "../keymap";
import { MAC_PRESET } from "./mac";
import { TERMINAL_SAFE_PRESET } from "./terminalSafe";
import { WINDOWS_PRESET } from "./windows";

export type PresetName = "default" | "terminal-safe";
export const PRESET_NAMES: readonly PresetName[] = ["default", "terminal-safe"];

export { MAC_PRESET, TERMINAL_SAFE_PRESET, WINDOWS_PRESET };

/** The table used on a platform. "terminal-safe" only changes Windows; macOS has no Ctrl conflicts to avoid. */
export function presetFor(platform: Platform, name: PresetName = "default"): Record<string, ShortcutSpec[]> {
  if (platform === "mac") return MAC_PRESET;
  return name === "terminal-safe" ? TERMINAL_SAFE_PRESET : WINDOWS_PRESET;
}
