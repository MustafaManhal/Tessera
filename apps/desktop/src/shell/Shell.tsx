// The main window (S-01): title bar with the tab strip, sidebar, pane area, status bar, plus the palette, the
// shortcut sheet, the close confirmation and the live region. `paneContent` is what each pane shows: the placeholder
// until the terminal lands (M1.2).
import { lazy, Suspense, useEffect, useSyncExternalStore } from "react";
import { NARROW_WIDTH } from "../actions/registry";
import { keymap } from "../actions/keymap";
import { useGlobalShortcuts } from "../actions/shortcuts";
import { ProjectsHost } from "../projects/ProjectsHost";
import { RestoreHost } from "../restore/RestoreHost";
import { ThemeHost } from "../themes/ThemeHost";
import { SettingsHost } from "../settings/SettingsHost";
import { NotificationHost } from "../notify/NotificationHost";
import { SecureKeyboardEntryHost } from "../native/SecureKeyboardEntryHost";
import { NativeMenuHost } from "../native/NativeMenuHost";
import { Announcer } from "./Announcer";
import { ConfirmClose } from "./ConfirmClose";
import { useWindowWidth } from "./dom";
import { ReviewPanel } from "../review/ReviewPanel";
import { PaneArea } from "./PaneArea";
import type { PaneContentComponent } from "./pane/PaneContent";
import { PanePlaceholder } from "./pane/PanePlaceholder";
import { Sidebar } from "./Sidebar";
import { AutomationsHost } from "../automations/AutomationsHost";
import { UpdatesHost } from "../updates/UpdatesHost";
import { PromptBar } from "../prompts/PromptBar";
import { OnboardingHost } from "../onboarding/OnboardingHost";
import { StatusBar } from "./StatusBar";
import { TitleBar } from "./TitleBar";
import { WindowPickerHost } from "./WindowMenu";
import { BroadcastHost } from "../terminal/BroadcastHost";
import { AgentsHost } from "../agents/AgentsHost";
import { SshPicker } from "../ssh/SshPicker";
import { useAppDispatch } from "../store/hooks";
import { requestPaneFocus } from "../store/uiSlice";
import { lazyOnOpen } from "./lazyOnOpen";
import { useAppSelector } from "../store/hooks";

// Screens that are used now and then load when first opened, not at start.
const AboutDialog = lazyOnOpen(
  () => import("../about/About").then((m) => ({ default: m.AboutDialog })),
  () => useAppSelector((s) => s.ui.aboutOpen),
);
const CommandPalette = lazyOnOpen(
  () => import("../palette/CommandPalette").then((m) => ({ default: m.CommandPalette })),
  () => useAppSelector((s) => s.ui.paletteOpen),
);
const ShortcutSheet = lazyOnOpen(
  () => import("../palette/ShortcutSheet").then((m) => ({ default: m.ShortcutSheet })),
  () => useAppSelector((s) => s.ui.sheetOpen),
);
const WhatsNewDialog = lazyOnOpen(
  () => import("../updates/WhatsNewDialog").then((m) => ({ default: m.WhatsNewDialog })),
  () => useAppSelector((s) => s.ui.whatsNewOpen),
);
const FeedbackDialog = lazyOnOpen(
  () => import("../feedback/FeedbackDialog").then((m) => ({ default: m.FeedbackDialog })),
  () => useAppSelector((s) => s.ui.feedbackOpen),
);
const BoardView = lazyOnOpen(
  () => import("../board/BoardView").then((m) => ({ default: m.BoardView })),
  () => useAppSelector((s) => s.ui.boardOpen),
);
const PromptLibraryDialog = lazyOnOpen(
  () => import("../prompts/PromptLibraryDialog").then((m) => ({ default: m.PromptLibraryDialog })),
  () => useAppSelector((s) => s.ui.promptLibraryOpen),
);

// The compare view pulls in the diff engine; load it when it is first opened.
const CompareView = lazy(() => import("../compare/CompareView").then((module) => ({ default: module.CompareView })));

export function Shell({ paneContent = PanePlaceholder }: { paneContent?: PaneContentComponent }) {
  useGlobalShortcuts();
  // Tooltips, menus and the sheet read shortcuts while rendering: a keymap change re-renders the whole window.
  useSyncExternalStore(keymap.subscribe, keymap.version);
  const narrow = useWindowWidth() < NARROW_WIDTH;
  const dispatch = useAppDispatch();

  // Typing goes to the first pane right away.
  useEffect(() => {
    dispatch(requestPaneFocus());
  }, [dispatch]);

  return (
    <div className="flex h-full flex-col bg-bg text-fg shell-backdrop">
      <TitleBar narrow={narrow} />
      <div className="relative flex min-h-0 flex-1">
        <Sidebar narrow={narrow} />
        <PaneArea content={paneContent} />
        <ReviewPanel />
      </div>
      <OnboardingHost />
      <PromptBar />
      <Suspense fallback={null}>
        <CompareView />
      </Suspense>
      <BoardView />
      <AutomationsHost />
      <UpdatesHost />
      <WhatsNewDialog />
      <FeedbackDialog />
      <StatusBar />
      <ConfirmClose />
      <CommandPalette />
      <ShortcutSheet />
      <AboutDialog />
      <NotificationHost />
      <PromptLibraryDialog />
      <SecureKeyboardEntryHost />
      <NativeMenuHost />
      <SettingsHost />
      <ProjectsHost />
      <ThemeHost />
      <RestoreHost />
      <WindowPickerHost />
      <BroadcastHost />
      <AgentsHost />
      <SshPicker />
      <Announcer />
    </div>
  );
}
