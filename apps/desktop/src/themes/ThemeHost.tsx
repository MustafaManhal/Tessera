// Mounted once in the Shell: puts the app theme on the window (every colour token on <html>, and `data-theme` set to the
// theme's kind so form controls and scrollbars follow), and lets the chrome next to the terminal blend with the terminal
// theme by setting `--term-bg` to its background. The terminal picker dialog lives here too.
import { t, useToast } from "@tessera/ui";
import { useEffect, useMemo } from "react";
import { reportNativeCommandError } from "../native/errors";
import { isNativeRuntime } from "../native/runtime";
import { createWindowEffectClient, isWindowEffectUnsupported } from "../native/windowEffect";
import { useAppDispatch, useAppSelector } from "../store/hooks";
import { setPaneDimUnfocused } from "../store/settingsSlice";
import { useActiveTheme, useColorTheme } from "../terminal/theme";
import { appearanceVariables, dimUnfocused } from "./appearance";
import { chromeVariables } from "./model";
import { ThemePicker } from "./ThemePicker";

/** Old builds kept a custom accent here; themes own their accent now. */
const LEGACY_ACCENT_KEY = "tessera.accent";

export function ThemeHost() {
  const appearance = useAppSelector((state) => state.config.values?.appearance);
  const theme = useColorTheme();
  const terminal = useActiveTheme();
  const dispatch = useAppDispatch();
  const { toast } = useToast();
  const effectClient = useMemo(() => createWindowEffectClient(), []);
  const blur = (appearance as Record<string, unknown> | undefined)?.["background-blur"] !== false;

  useEffect(() => {
    const root = document.documentElement;
    root.dataset.theme = theme.kind;
    root.dataset.colorTheme = theme.id;
    for (const [name, value] of Object.entries(theme.variables)) root.style.setProperty(name, value);
  }, [theme]);

  useEffect(() => {
    try {
      localStorage.removeItem(LEGACY_ACCENT_KEY);
    } catch {
      // Blocked storage: nothing to clean up.
    }
  }, []);

  useEffect(() => {
    const root = document.documentElement;
    for (const [name, value] of Object.entries(appearanceVariables({ appearance }))) {
      root.style.setProperty(name, value);
    }
  }, [appearance]);

  // `appearance.dim-unfocused` feeds the pane dimming the pane area already draws.
  useEffect(() => {
    dispatch(setPaneDimUnfocused(dimUnfocused({ appearance })));
  }, [appearance, dispatch]);

  useEffect(() => {
    if (!isNativeRuntime()) return;
    void effectClient.set(blur ? "blur" : "none").catch((error: unknown) => {
      if (isWindowEffectUnsupported(error)) {
        toast({ kind: "info", title: t("native.windowEffectUnsupported") });
      } else {
        reportNativeCommandError("native.windowEffectFailed", error);
      }
    });
  }, [blur, effectClient, toast]);

  useEffect(() => {
    const root = document.documentElement;
    for (const [name, value] of Object.entries(chromeVariables(terminal))) root.style.setProperty(name, value);
  }, [terminal]);

  return <ThemePicker />;
}
