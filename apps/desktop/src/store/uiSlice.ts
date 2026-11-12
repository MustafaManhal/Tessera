// UI state that is not part of the layout JSON: open dialogs, recent palette actions, the tab being renamed, a
// pending close confirmation, the live-region message, and requests to move keyboard focus into the focused pane.
// (The sidebar's width and visibility and the closed-tab stack live in the layout slice: they belong to the layout
// model and the sidebar is part of the §5.3 layout JSON.)
import { createSlice, type PayloadAction } from "@reduxjs/toolkit";
import type { StringKey } from "@tessera/ui";
import type { PaneId, TabId } from "../layout";

export const RECENT_MAX = 5;

/** A close that stops a running process waits for the user (F-03 step 7). Plain data, so it stays serializable. */
export type PendingClose =
  | { kind: "tab"; tabId: TabId }
  | { kind: "pane"; paneId: PaneId }
  | { kind: "others"; tabId: TabId };

export interface ConfirmState {
  close: PendingClose;
  title: StringKey;
  processes: string[];
}

export interface BroadcastState {
  tabId: string;
  paneIds: PaneId[];
}

/** The one project or task dialog that is open (add project, new task, project settings, deletes). */
export type ProjectDialog =
  | { kind: "addProject" }
  | { kind: "newTask"; projectId: string | null; prompt?: string }
  | { kind: "newTaskGroup"; projectId: string | null }
  | { kind: "projectSettings"; projectId: string }
  | { kind: "deleteTask"; taskId: string }
  | { kind: "removeProject"; projectId: string }
  | { kind: "archiveGroupOthers"; groupId: string };

export interface UiState {
  projectDialog: ProjectDialog | null;
  paletteOpen: boolean;
  sheetOpen: boolean;
  aboutOpen: boolean;
  /** The S-06 board view. */
  boardOpen: boolean;
  /** The What's new dialog. */
  whatsNewOpen: boolean;
  settingsOpen: boolean;
  /** The S-16 "Needs you" inbox popover. */
  inboxOpen: boolean;
  /** Bumped whenever an inbox row is recorded, so open popovers refetch. */
  inboxVersion: number;
  /** The prompt bar (FR-40): open flag plus an optional preset (text/targets) from "Send to agent". */
  promptBar: { open: boolean; text: string; agentSessionIds: string[] } | null;
  /** The S-23 prompt library dialog. */
  promptLibraryOpen: boolean;
  /** The S-08 compare view: the best-of-N group id it shows, or null. */
  compareGroup: string | null;
  /** The Settings section a command asked for (e.g. `agents.open`); the dialog opens on it. */
  settingsPage: string | null;
  themePickerOpen: boolean;
  windowPickerOpen: boolean;
  broadcast: BroadcastState | null;
  /** Action ids, most recent first. */
  recentActions: string[];
  renamingTab: TabId | null;
  confirm: ConfirmState | null;
  /** Text for the polite live region; `id` changes so the same text is announced again. */
  announcement: { text: string; id: number } | null;
  /** Bumped when keyboard focus should move into the focused pane. */
  paneFocusRequest: number;
  /** The app window has the OS focus (notifications and long-command alerts only fire without it, or elsewhere). */
  windowFocused: boolean;
  /** The "Allow notifications?" explanation is showing. */
  notificationPrompt: boolean;
}

const initialState: UiState = {
  projectDialog: null,
  paletteOpen: false,
  sheetOpen: false,
  aboutOpen: false,
  boardOpen: false,
  whatsNewOpen: false,
  settingsOpen: false,
  inboxOpen: false,
  inboxVersion: 0,
  promptBar: null,
  promptLibraryOpen: false,
  compareGroup: null,
  settingsPage: null,
  themePickerOpen: false,
  windowPickerOpen: false,
  broadcast: null,
  recentActions: [],
  renamingTab: null,
  confirm: null,
  announcement: null,
  paneFocusRequest: 0,
  windowFocused: true,
  notificationPrompt: false,
};

export const uiSlice = createSlice({
  name: "ui",
  initialState,
  reducers: {
    /** Opening the palette closes the shortcut sheet and the other way round: one dialog at a time. */
    setPaletteOpen: (state, action: PayloadAction<boolean>) => {
      state.paletteOpen = action.payload;
      if (action.payload) state.sheetOpen = false;
    },
    setSheetOpen: (state, action: PayloadAction<boolean>) => {
      state.sheetOpen = action.payload;
      if (action.payload) state.paletteOpen = false;
    },
    setInboxOpen: (state, action: PayloadAction<boolean>) => {
      state.inboxOpen = action.payload;
    },
    bumpInbox: (state) => {
      state.inboxVersion += 1;
    },
    openPromptBar: (state, action: PayloadAction<{ text?: string; agentSessionIds?: string[] } | undefined>) => {
      state.promptBar = {
        open: true,
        text: action.payload?.text ?? "",
        agentSessionIds: action.payload?.agentSessionIds ?? [],
      };
    },
    closePromptBar: (state) => {
      if (state.promptBar) state.promptBar.open = false;
    },
    setPromptLibraryOpen: (state, action: PayloadAction<boolean>) => {
      state.promptLibraryOpen = action.payload;
    },
    setAboutOpen: (state, action: PayloadAction<boolean>) => {
      state.aboutOpen = action.payload;
      if (action.payload) {
        state.paletteOpen = false;
        state.sheetOpen = false;
      }
    },
    /** Opens a project or task dialog (closing the palette), or closes it with null. */
    setWhatsNewOpen: (state, action: PayloadAction<boolean>) => {
      state.whatsNewOpen = action.payload;
      if (action.payload) state.paletteOpen = false;
    },
    setBoardOpen: (state, action: PayloadAction<boolean>) => {
      state.boardOpen = action.payload;
      if (action.payload) state.paletteOpen = false;
    },
    setCompareGroup: (state, action: PayloadAction<string | null>) => {
      state.compareGroup = action.payload;
    },
    setProjectDialog: (state, action: PayloadAction<ProjectDialog | null>) => {
      state.projectDialog = action.payload;
      if (action.payload) state.paletteOpen = false;
    },
    setThemePickerOpen: (state, action: PayloadAction<boolean>) => {
      state.themePickerOpen = action.payload;
      if (action.payload) {
        state.paletteOpen = false;
        state.sheetOpen = false;
      }
    },
    setWindowPickerOpen: (state, action: PayloadAction<boolean>) => {
      state.windowPickerOpen = action.payload;
      if (action.payload) {
        state.paletteOpen = false;
        state.sheetOpen = false;
      }
    },
    setBroadcast: (state, action: PayloadAction<BroadcastState | null>) => {
      state.broadcast = action.payload
        ? { tabId: action.payload.tabId, paneIds: [...new Set(action.payload.paneIds)] }
        : null;
    },
    setBroadcastPanes: (state, action: PayloadAction<PaneId[]>) => {
      if (state.broadcast) state.broadcast.paneIds = [...new Set(action.payload)];
    },
    setSettingsOpen: (state, action: PayloadAction<boolean>) => {
      state.settingsOpen = action.payload;
      if (action.payload) {
        state.paletteOpen = false;
        state.sheetOpen = false;
        state.aboutOpen = false;
      }
    },
    setSettingsPage: (state, action: PayloadAction<string | null>) => {
      state.settingsPage = action.payload;
    },
    noteRecent: (state, action: PayloadAction<string>) => {
      state.recentActions = [action.payload, ...state.recentActions.filter((id) => id !== action.payload)].slice(
        0,
        RECENT_MAX,
      );
    },
    setRenamingTab: (state, action: PayloadAction<TabId | null>) => {
      state.renamingTab = action.payload;
    },
    requestConfirm: (state, action: PayloadAction<ConfirmState | null>) => {
      state.confirm = action.payload;
    },
    announce: (state, action: PayloadAction<string>) => {
      state.announcement = { text: action.payload, id: (state.announcement?.id ?? 0) + 1 };
    },
    requestPaneFocus: (state) => {
      state.paneFocusRequest += 1;
    },
    setWindowFocused: (state, action: PayloadAction<boolean>) => {
      state.windowFocused = action.payload;
    },
    setNotificationPrompt: (state, action: PayloadAction<boolean>) => {
      state.notificationPrompt = action.payload;
    },
  },
});

export const {
  setInboxOpen,
  bumpInbox,
  openPromptBar,
  closePromptBar,
  setPromptLibraryOpen,
  setAboutOpen,
  setSettingsOpen,
  setSettingsPage,
  setThemePickerOpen,
  setWindowPickerOpen,
  setBroadcast,
  setBroadcastPanes,
  setBoardOpen,
  setWhatsNewOpen,
  setCompareGroup,
  setProjectDialog,
  setPaletteOpen,
  setSheetOpen,
  noteRecent,
  setRenamingTab,
  requestConfirm,
  announce,
  requestPaneFocus,
  setWindowFocused,
  setNotificationPrompt,
} = uiSlice.actions;
