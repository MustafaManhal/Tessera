// The app theme and the terminal theme. The app theme (packages/ui colorThemes) is `appearance.color-theme`, or, with
// `appearance.follow-system`, the preferred light or dark theme for the computer's setting. The terminal uses the app
// theme's own palette unless `appearance.terminal-theme` names another one; a theme the picker is previewing wins until
// the preview ends.
import type { EngineTheme } from "@tessera/term";
import { type ColorTheme, colorThemeOr, findColorTheme, withAccent } from "@tessera/ui";
import { useEffect, useMemo, useState } from "react";
import { useAppSelector } from "../store/hooks";
import { loadBundledThemes, resolveTheme, terminalOf } from "../themes/catalog";
import { type Appearance, toEngineTheme, type Theme } from "../themes/model";

type AppearanceConfig = Record<string, unknown> | undefined;

const DARK_QUERY = "(prefers-color-scheme: dark)";

function systemDark(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia(DARK_QUERY).matches
    : true;
}

/** The computer's light or dark setting, updated live. */
export function useSystemDark(): boolean {
  const [dark, setDark] = useState(systemDark);
  useEffect(() => {
    const media = window.matchMedia(DARK_QUERY);
    const update = () => setDark(media.matches);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  return dark;
}

/** The app theme the settings choose for the computer's current setting, before any primary colour override. */
export function selectColorTheme(appearance: AppearanceConfig, dark: boolean): ColorTheme {
  if (appearance?.["follow-system"] === true) {
    return dark
      ? colorThemeOr(appearance["preferred-dark-theme"], "dark")
      : colorThemeOr(appearance["preferred-light-theme"], "light");
  }
  return findColorTheme(appearance?.["color-theme"]) ?? colorThemeOr(null, dark ? "dark" : "light");
}

/** The app theme in use now, with the primary colour the user picked (`appearance.accent`) when there is one. */
export function useColorTheme(): ColorTheme {
  const appearance = useAppSelector((state) => state.config.values?.appearance) as AppearanceConfig;
  const dark = useSystemDark();
  return useMemo(() => withAccent(selectColorTheme(appearance, dark), appearance?.accent), [appearance, dark]);
}

/** Light or dark: the kind of the app theme ThemeHost put on the page (`data-theme`), else the computer's setting. */
export function currentMode(): Appearance {
  const forced = document.documentElement.dataset.theme;
  if (forced === "light" || forced === "dark") return forced;
  return systemDark() ? "dark" : "light";
}

/** The terminal theme in use: the preview, else what `terminal-theme` names, else the app theme's own palette. */
export function useActiveTheme(): Theme {
  const appearance = useAppSelector((state) => state.config.values?.appearance) as AppearanceConfig;
  const imported = useAppSelector((state) => state.themes.imported);
  const preview = useAppSelector((state) => state.themes.preview);
  const app = useColorTheme();
  const name = typeof appearance?.["terminal-theme"] === "string" ? appearance["terminal-theme"] : "";
  const [bundled, setBundled] = useState<Theme[]>([]);
  const needsBundle = !preview && name.trim() !== "" && resolveTheme(name, imported, []) === null;
  useEffect(() => {
    if (!needsBundle || bundled.length > 0) return;
    let cancelled = false;
    void loadBundledThemes().then((list) => !cancelled && setBundled(list));
    return () => {
      cancelled = true;
    };
  }, [needsBundle, bundled.length]);
  return useMemo(
    () => preview ?? resolveTheme(name, imported, bundled) ?? terminalOf(app),
    [preview, name, imported, bundled, app],
  );
}

let last: EngineTheme | null = null;

/** The terminal theme last in use, for a terminal created before its first render (the default app theme otherwise). */
export function readTerminalTheme(): EngineTheme {
  return last ?? toEngineTheme(terminalOf(colorThemeOr(null, currentMode())));
}

/** The terminal's theme, updated when the app theme, the config, the imports or the preview change. */
export function useTerminalTheme(): EngineTheme {
  const active = useActiveTheme();
  const theme = useMemo(() => toEngineTheme(active), [active]);
  last = theme;
  return theme;
}
