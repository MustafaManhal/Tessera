import { getValue } from "../settings/schema";

/** CSS opacity for the window's rendered content, defaulting to fully opaque on missing or invalid config. */
export function windowOpacity(config: unknown): number {
  const value = getValue(config, "appearance.window-opacity");
  if (typeof value !== "number" || !Number.isFinite(value)) return 1;
  return Math.min(1, Math.max(0, value));
}

/** Terminal padding in pixels (0 to 32); 6 on missing or invalid config. */
export function terminalPadding(config: unknown): number {
  const value = getValue(config, "appearance.padding");
  if (typeof value !== "number" || !Number.isFinite(value)) return 6;
  return Math.min(32, Math.max(0, Math.round(value)));
}

/** How much panes without focus are dimmed (0 to 0.6); 0 on missing or invalid config. */
export function dimUnfocused(config: unknown): number {
  const value = getValue(config, "appearance.dim-unfocused");
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return Math.min(0.6, Math.max(0, value));
}

export function appearanceVariables(config: unknown): Record<string, string> {
  return {
    "--window-opacity": String(windowOpacity(config)),
    "--terminal-padding": `${terminalPadding(config)}px`,
  };
}
