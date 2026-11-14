// The app's accent colour (the "primary colour"): baby blue by default, a few presets, or any colour the user picks.
// Kept on this computer (like the restore switch). The fill is used for buttons and marks; text, borders, the focus ring
// and switches need more contrast, so an "ink" is derived from the fill for each mode (WCAG 1.4.3 and 1.4.11).
import { useSyncExternalStore } from "react";
import { contrastOf, normalizeHex } from "./model";

export const ACCENT_KEY = "tessera.accent";
export const DEFAULT_ACCENT = "#89cff0";

export const ACCENT_PRESETS: { id: string; fill: string }[] = [
  { id: "babyblue", fill: DEFAULT_ACCENT },
  { id: "mint", fill: "#8fe3c0" },
  { id: "lavender", fill: "#c3b1f5" },
  { id: "peach", fill: "#ffc09a" },
  { id: "rose", fill: "#f7a8c4" },
  { id: "lemon", fill: "#f3e48a" },
  { id: "silver", fill: "#d4d4d4" },
];

const LIGHT_WORST = "#e8e8e8"; // --surface-3, light: the lowest-contrast surface the ink sits on
const DARK_WORST = "#1f1f1f"; // --surface-3, dark

const channels = (hex: string): [number, number, number] => [
  Number.parseInt(hex.slice(1, 3), 16),
  Number.parseInt(hex.slice(3, 5), 16),
  Number.parseInt(hex.slice(5, 7), 16),
];
const toHex = (rgb: number[]) => `#${rgb.map((c) => Math.round(c).toString(16).padStart(2, "0")).join("")}`;

/** `hex` moved `amount` (0 to 1) toward `target`. */
export function mixHex(hex: string, target: string, amount: number): string {
  const a = channels(hex);
  const b = channels(target);
  return toHex(a.map((c, i) => c + ((b[i] ?? 0) - c) * amount));
}

/** Moves `fill` toward `target` in small steps until it has `min` contrast on `surface`. */
function reach(fill: string, target: string, surface: string, min: number): string {
  let colour = fill;
  for (let step = 0; step <= 20 && contrastOf(colour, surface) < min; step++)
    colour = mixHex(fill, target, step * 0.05);
  return colour;
}

export interface AccentColours {
  /** Buttons and marks. */
  accent: string;
  /** Text and icons on the fill. */
  fg: string;
  /** The accent as text, borders, focus ring and switch track. */
  ink: string;
}

/** The three colours for a fill in a mode. The ink keeps at least 4.5:1 on the surfaces of that mode. */
export function deriveAccent(fill: string, mode: "light" | "dark"): AccentColours {
  const fg = contrastOf("#0a0a0a", fill) >= contrastOf("#ffffff", fill) ? "#0a0a0a" : "#ffffff";
  const ink = mode === "light" ? reach(fill, "#000000", LIGHT_WORST, 4.5) : reach(fill, "#ffffff", DARK_WORST, 4.5);
  return { accent: fill, fg: mode === "dark" && fg === "#0a0a0a" ? "#000000" : fg, ink };
}

type Listener = () => void;
const listeners = new Set<Listener>();

export function readAccent(): string {
  try {
    return normalizeHex(localStorage.getItem(ACCENT_KEY)) ?? DEFAULT_ACCENT;
  } catch {
    return DEFAULT_ACCENT;
  }
}

let current = readAccent();

export function saveAccent(hex: string): void {
  const next = normalizeHex(hex) ?? DEFAULT_ACCENT;
  current = next;
  try {
    localStorage.setItem(ACCENT_KEY, next);
  } catch {
    // Blocked storage: the choice lasts for this session.
  }
  for (const listener of listeners) listener();
}

export function useAccent(): string {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => current,
  );
}

/** Puts the accent on the page. The default leaves the token files in charge, so nothing is overridden. */
export function applyAccent(root: HTMLElement, fill: string, mode: "light" | "dark"): void {
  const names = ["--accent", "--accent-fg", "--accent-ink"];
  if (fill === DEFAULT_ACCENT) {
    for (const name of names) root.style.removeProperty(name);
    return;
  }
  const { accent, fg, ink } = deriveAccent(fill, mode);
  root.style.setProperty("--accent", accent);
  root.style.setProperty("--accent-fg", fg);
  root.style.setProperty("--accent-ink", ink);
}
