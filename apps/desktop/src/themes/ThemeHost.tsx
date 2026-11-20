// Mounted once in the Shell: applies `appearance.theme` (system, light or dark) to the window through `data-theme`, and
// lets the chrome next to the terminal blend with the active theme by setting `--term-bg` to its background.
// The picker dialog (S-12) lives here too.
import { t, useToast } from "@tessera/ui";
import { useEffect, useMemo } from "react";
import { reportNativeCommandError } from "../native/errors";
import { isNativeRuntime } from "../native/runtime";
import { createWindowEffectClient, isWindowEffectUnsupported } from "../native/windowEffect";
import { useAppDispatch, useAppSelector } from "../store/hooks";
import { setPaneDimUnfocused } from "../store/settingsSlice";
import { useActiveTheme, useAppearance } from "../terminal/theme";
import { applyAccent, useAccent } from "./accent";
import { appearanceVariables, dimUnfocused } from "./appearance";
import { chromeVariables } from "./model";
import { ThemePicker } from "./ThemePicker";

export function ThemeHost() {
  const mode = useAppSelector(
    (state) => (state.config.values?.appearance as Record<string, unknown> | undefined)?.theme,
  );
  const appearance = useAppSelector((state) => state.config.values?.appearance);
  const active = useActiveTheme();
  const accent = useAccent();
  const resolvedMode = useAppearance();
  const dispatch = useAppDispatch();
  const { toast } = useToast();
  const effectClient = useMemo(() => createWindowEffectClient(), []);
  const blur = (appearance as Record<string, unknown> | undefined)?.["background-blur"] !== false;

  useEffect(() => {
    const root = document.documentElement;
    if (mode === "light" || mode === "dark") root.dataset.theme = mode;
    else if (mode === "system" && root.dataset.theme) delete root.dataset.theme;
  }, [mode]);

  useEffect(() => {
    applyAccent(document.documentElement, accent, resolvedMode);
  }, [accent, resolvedMode]);

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
    const variables = chromeVariables(active);
    for (const name of ["--term-bg"]) {
      const value = variables[name];
      if (value) root.style.setProperty(name, value);
      else root.style.removeProperty(name);
    }
  }, [active]);

  return <ThemePicker />;
}
