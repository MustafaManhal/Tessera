// The terminal theme (M4.5): the app's light/dark mode (the system setting, or `appearance.theme` forcing one through
// `data-theme`) picks which of `appearance.theme-light` / `appearance.theme-dark` is in use. The built-in palettes follow
// the design tokens, so the chrome next to the terminal blends (UI-UX §2, `--term-bg`); any other theme comes from the
// catalog, its background becomes `--term-bg`, and a theme the picker is previewing wins until the preview ends.
import { DEFAULT_THEMES, type EngineTheme } from "@tessera/term";
import { useEffect, useMemo, useState } from "react";
import { useAppSelector } from "../store/hooks";
import { BUILTIN_NAMES, isBuiltinName, loadBundledThemes, resolveTheme } from "../themes/catalog";
import { type Appearance, toEngineTheme, type Theme } from "../themes/model";

export function currentMode(): Appearance {
  const forced = document.documentElement.dataset.theme;
  if (forced === "light" || forced === "dark") return forced;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

/** The built-in palette for the mode, blended with the design tokens. */
export function readTerminalTheme(): EngineTheme {
  const mode = currentMode();
  const css = getComputedStyle(document.documentElement);
  const token = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
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
  // biome-ignore lint/correctness/useExhaustiveDependencies: the tokens are re-read when the mode changes.
  useEffect(() => setTokens(readTerminalTheme()), [mode]);
  return active ? toEngineTheme(active) : tokens;
}
