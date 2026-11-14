// S-15 quick terminal: the window the global hotkey drops from the top of the screen. A mini tab strip and the panes;
// no sidebar, status bar or window menu. It keeps its own tabs (its layout is saved under the window id "quick").
// Rust slides the window; with reduced motion it appears in place and the content fades in (`quick-terminal:shown`).
import { listen } from "@tauri-apps/api/event";
import { IconButton, Icons, getPlatform, t } from "@tessera/ui";
import { useEffect, useRef, useSyncExternalStore } from "react";
import { AboutDialog } from "../about/About";
import { primaryShortcut } from "../actions/registry";
import { keymap } from "../actions/keymap";
import { useGlobalShortcuts } from "../actions/shortcuts";
import { hideQuickTerminal, reportReducedMotion } from "../native/quickTerminal";
import { isNativeRuntime } from "../native/runtime";
import { reportNativeCommandError } from "../native/errors";
import { SecureKeyboardEntryHost } from "../native/SecureKeyboardEntryHost";
import { NotificationHost } from "../notify/NotificationHost";
import { CommandPalette } from "../palette/CommandPalette";
import { ShortcutSheet } from "../palette/ShortcutSheet";
import { RestoreHost } from "../restore/RestoreHost";
import { SettingsHost } from "../settings/SettingsHost";
import { useAppDispatch, useAppSelector } from "../store/hooks";
import { layout } from "../store/layoutSlice";
import { selectTabs } from "../store/selectors";
import { requestPaneFocus } from "../store/uiSlice";
import { BroadcastHost } from "../terminal/BroadcastHost";
import { ThemeHost } from "../themes/ThemeHost";
import { Announcer } from "./Announcer";
import { ConfirmClose } from "./ConfirmClose";
import { PaneArea } from "./PaneArea";
import type { PaneContentComponent } from "./pane/PaneContent";
import { TabStrip } from "./TabStrip";

const REDUCED_MOTION = "(prefers-reduced-motion: reduce)";

export function QuickShell({ paneContent }: { paneContent: PaneContentComponent }) {
  useGlobalShortcuts();
  useSyncExternalStore(keymap.subscribe, keymap.version);
  const dispatch = useAppDispatch();
  const tabs = useAppSelector(selectTabs);
  const root = useRef<HTMLDivElement>(null);

  // Rust needs the motion preference before the next show.
  useEffect(() => {
    const query = window.matchMedia(REDUCED_MOTION);
    const report = () => void reportReducedMotion(query.matches).catch(() => {});
    report();
    query.addEventListener("change", report);
    return () => query.removeEventListener("change", report);
  }, []);

  // Every show: focus the pane; with reduced motion Rust does not slide, so fade the content in (180 ms, UI/UX §motion).
  useEffect(() => {
    if (!isNativeRuntime()) return;
    const stop = listen("quick-terminal:shown", () => {
      dispatch(requestPaneFocus());
      if (window.matchMedia(REDUCED_MOTION).matches)
        root.current?.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 180, easing: "cubic-bezier(.2,.8,.2,1)" });
    });
    return () => void stop.then((unlisten) => unlisten());
  }, [dispatch]);

  // Closing the last tab hides the quick terminal; a fresh shell waits for the next show.
  useEffect(() => {
    if (tabs.length > 0) return;
    dispatch(layout({ type: "tab/new" }));
    hideQuickTerminal().catch((error: unknown) => reportNativeCommandError("native.windowFailed", error));
  }, [tabs.length, dispatch]);

  return (
    <div ref={root} className="flex h-full flex-col bg-bg text-fg">
      <header className="flex h-8 shrink-0 items-stretch border-b border-border bg-surface">
        <TabStrip />
        <div className="min-w-6 flex-1" />
        <div className="flex items-center px-1">
          <IconButton
            icon={Icons.ChevronUp}
            label={t("action.view.quickTerminal")}
            shortcut={primaryShortcut("view.quickTerminal", getPlatform())}
            size="sm"
            onClick={() =>
              void hideQuickTerminal().catch((error: unknown) => reportNativeCommandError("native.windowFailed", error))
            }
          />
        </div>
      </header>
      <div className="relative flex min-h-0 flex-1">
        <PaneArea content={paneContent} />
      </div>
      <ConfirmClose />
      <CommandPalette />
      <ShortcutSheet />
      <AboutDialog />
      <NotificationHost />
      <SecureKeyboardEntryHost />
      <SettingsHost />
      <ThemeHost />
      <RestoreHost />
      <BroadcastHost />
      <Announcer />
    </div>
  );
}
