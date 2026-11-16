// The terminal theme (M4.5): the app's light/dark mode (the system setting, or `appearance.theme` forcing one through
// `data-theme`) picks which of `appearance.theme-light` / `appearance.theme-dark` is in use. The built-in palettes follow
// the design tokens, so the chrome next to the terminal blends (UI-UX §2, `--term-bg`); any other theme comes from the
// catalog, its background becomes `--term-bg`, and a theme the picker is previewing wins until the preview ends.
import { DEFAULT_THEMES, type EngineTheme } from "@tessera/term";
import { useEffect, useMemo, useState } from "react";
import { useAppSelector } from "../store/hooks";
import { useAccent } from "../themes/accent";
import { BUILTIN_NAMES, isBuiltinName, loadBundledThemes, resolveTheme } from "../themes/catalog";
import { type Appearance, toEngineTheme, type Theme } from "../themes/model";

export function currentMode(): Appearance {
  const forced = document.documentElement.dataset.theme;
  if (forced === "light" || forced === "dark") return forced;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

let probe: CanvasRenderingContext2D | null | undefined;

/**
 * "#rrggbb" for any CSS colour, including `color-mix(...)` (the surface tokens mix the accent into the neutrals, and
 * a terminal needs a plain colour). null when the browser cannot read it.
 */
export function cssColorToHex(value: string): string | null {
  if (!value) return null;
  if (/^#[0-9a-f]{6}$/i.test(value)) return value.toLowerCase();
  try {
    if (probe === undefined) {
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 1;
      probe = canvas.getContext("2d", { willReadFrequently: true });
    }
    if (!probe) return null;
    probe.clearRect(0, 0, 1, 1);
    probe.fillStyle = "#000000";
    probe.fillStyle = value;
    probe.fillRect(0, 0, 1, 1);
    const [r = 0, g = 0, b = 0] = probe.getImageData(0, 0, 1, 1).data;
    return `#${[r, g, b].map((c) => c.toString(16).padStart(2, "0")).join("")}`;
  } catch {
    return null;
  }
}

/** The built-in palette for the mode, blended with the design tokens. */
export function readTerminalTheme(): EngineTheme {
  const mode = currentMode();
  const css = getComputedStyle(document.documentElement);
  const token = (name: string, fallback: string) => cssColorToHex(css.getPropertyValue(name).trim()) ?? fallback;
  const base = DEFAULT_THEMES[mode];
  const background = token("--bg", base.background);
  const foreground = token("--text", base.foreground);
  return { ...base, background, foreground, cursor: foreground, cursorAccent: background };
}

/** The mode (light or dark) now, following `data-theme` and the system setting. */
export function useAppearance(): Appearance {
  const [mode, setMode] = useState(currentMode);
  useEffect(() => {
    const update = () => setMode(currentMode());
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    media.addEventListener("change", update);
    const observer = new MutationObserver(update);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => {
      media.removeEventListener("change", update);
      observer.disconnect();
    };
  }, []);
  return mode;
}

/** The theme in use for a mode: the preview, else what the config names. null means the built-in palette. */
export function useActiveTheme(): Theme | null {
  const mode = useAppearance();
  const appearance = useAppSelector((state) => state.config.values?.appearance) as Record<string, unknown> | undefined;
  const imported = useAppSelector((state) => state.themes.imported);
  const preview = useAppSelector((state) => state.themes.preview);
  const name = String(appearance?.[mode === "dark" ? "theme-dark" : "theme-light"] ?? BUILTIN_NAMES[mode]);
  const [bundled, setBundled] = useState<Theme[]>([]);
  const needsBundle = !preview && resolveTheme(name, imported, []) === null && !isBuiltinName(name);
  useEffect(() => {
    if (!needsBundle || bundled.length > 0) return;
    let cancelled = false;
    void loadBundledThemes().then((list) => !cancelled && setBundled(list));
    return () => {
      cancelled = true;
    };
  }, [needsBundle, bundled.length]);
  return useMemo(() => preview ?? resolveTheme(name, imported, bundled), [preview, name, imported, bundled]);
}

/** The terminal's theme, updated when the mode, the config, the imports or the preview change. */
export function useTerminalTheme(): EngineTheme {
  const active = useActiveTheme();
  const mode = useAppearance();
  const [tokens, setTokens] = useState(readTerminalTheme);
  const accent = useAccent();
  // biome-ignore lint/correctness/useExhaustiveDependencies: the tokens are re-read when the mode or the accent changes.
  useEffect(() => {
    // After ThemeHost has put the accent on the page (its effect may run later in the same commit).
    const timer = setTimeout(() => setTokens(readTerminalTheme()), 0);
    return () => clearTimeout(timer);
  }, [mode, accent]);
  return active ? toEngineTheme(active) : tokens;
}
