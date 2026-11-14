// The action registry (TRD §4.11, M4.3): every user action once, with its label (catalog key), group, shortcuts
// per platform, when it is available and what it does. The key handler, the command palette, the shortcut sheet,
// tooltips and menus all read this list, so a shortcut shown anywhere is the one that works.
//
// Shortcuts are platform-neutral strings ("Mod" is Command on macOS, Ctrl elsewhere). Defaults follow 04-app-flow
// F-03 and 03-UI-UX §3; Windows uses Ctrl+Shift (or Ctrl+Alt) chords so plain Ctrl keys reach the shell.
import { type Block, FONT_SIZE, isFinished, outputLineCount } from "@tessera/term";
import { getPlatform, type Platform, type StringKey, t } from "@tessera/ui";
import {
  activeTabOf,
  type Direction,
  type LayoutState,
  neighbor,
  nodeAt,
  paneIds,
  pathToPane,
  type Tab,
} from "../layout";
import { type AppDispatch, type RootState, store } from "../store";
import { layout } from "../store/layoutSlice";
import { setTerminal, zoomFont } from "../store/settingsSlice";
import { closeOtherTabs, closePane, closeTab } from "../store/thunks";
import {
  setAboutOpen,
  setBoardOpen,
  setWhatsNewOpen,
  setFeedbackOpen,
  setPaletteOpen,
  setRenamingTab,
  setSettingsOpen,
  setSettingsPage,
  setCompareGroup,
  setSheetOpen,
  setThemePickerOpen,
  setWindowPickerOpen,
  setBroadcast,
} from "../store/uiSlice";
import { runScriptAction } from "../sidebar/runScripts";
import {
  archiveTaskAction,
  openTaskInEditorAction,
  requestDeleteTask,
  restoreTaskAction,
} from "../sidebar/taskActions";
import { requestNewTask } from "../sidebar/projectActions";
import { currentTaskId, openRelativeTask, taskOrder } from "../sidebar/taskTabs";
import { jumpToNextAttention } from "../agents/jump";
import { openPromptBar, setInboxOpen, setProjectDialog, setPromptLibraryOpen } from "../store/uiSlice";
import { toggleDnd } from "../notify/dnd";
import { focusedTerminal } from "../terminal/panes";
import { reportNativeCommandError } from "../native/errors";
import { isNativeRuntime } from "../native/runtime";
import { setSecureKeyboardEntry } from "../native/secureKeyboardEntry";
import { transferTab, undoTabTransfer, windowClient } from "../native/windows";
import { toggleQuickTerminal } from "../native/quickTerminal";
import { focusedAgentPane, resumeAgentPane, restartAgentPane, stopAgentInPane } from "../agents/launch";
import { setAgentPicker } from "../agents/sessionsSlice";
import { setSshPicker } from "../ssh/sshSlice";
import { toggleReview } from "../review/model";
import { notifications } from "../notify";
import { configureBroadcastRouting } from "../terminal/broadcast";

export type ActionGroup = "tabs" | "panes" | "terminal" | "projects" | "view";

export const GROUP_LABELS: Record<ActionGroup, StringKey> = {
  tabs: "group.tabs",
  panes: "group.panes",
  terminal: "group.terminal",
  projects: "group.projects",
  view: "group.view",
};

// Shortcuts are not part of an action's definition: the default tables live in `presets/` (one per platform preset) and
// `keymap.ts` merges the user's overrides from the config. Chords are "Mod+Shift+P" strings; an entry can be limited to
// the tab strip, or "native" (the key handler lets the WebView fire its own clipboard event: paste needs that event,
// because reading the clipboard from script asks the user for permission in WKWebView).
import { keymap } from "./keymap";

export interface ActionContext {
  layout: LayoutState;
  state: RootState;
  dispatch: AppDispatch;
  /** Set when a tab-strip-scoped shortcut fired, so the action keeps focus in the tab strip. */
  source?: "tabStrip";
}

export type Availability = { ok: true } | { ok: false; reason: StringKey; vars?: Record<string, string | number> };

export interface AppAction {
  /** Stable id (`tab.new`), used for keybinding overrides (M4.4) and recent actions. */
  id: string;
  label: StringKey;
  labelVars?: Record<string, string | number>;
  /** A label that depends on the state (Pin / Unpin). */
  labelFor?: (ctx: ActionContext) => StringKey;
  group: ActionGroup;
  /** Extra words the palette matches. */
  keywords?: string[];
  /** Also fires while a dialog has focus (toggling the palette and the sheet). */
  inDialog?: boolean;
  /** Hidden from the palette while unavailable, instead of shown dimmed (the 9 "go to tab" actions). */
  hideWhenUnavailable?: boolean;
  when?: (ctx: ActionContext) => Availability;
  run: (ctx: ActionContext) => void;
}

const OK: Availability = { ok: true };
const no = (reason: StringKey, vars?: Record<string, string | number>): Availability => ({ ok: false, reason, vars });

const hasTab = ({ layout }: ActionContext) => (activeTabOf(layout) ? OK : no("reason.noTab"));

function showWindowError(error: unknown): void {
  notifications().toastNow({
    kind: "error",
    title: t("native.windowFailed", { message: error instanceof Error ? error.message : String(error) }),
  });
}

async function moveTabToWindow(ctx: ActionContext, targetId: string): Promise<void> {
  const tab = activeTabOf(ctx.layout);
  if (!tab) return;
  const moved = await transferTab(ctx.layout, ctx.dispatch, tab.id, targetId, () => store.getState().layout);
  notifications().toastNow({
    kind: "success",
    title: t("window.tabMoved", { title: tab.title ?? t("tab.untitled") }),
    onUndo: () => void undoTabTransfer(moved.tabJson, moved.sourceId, moved.targetId).catch(showWindowError),
  });
}

const hasTerminal = ({ layout }: ActionContext) => (focusedTerminal(layout) ? OK : no("reason.noTerminal"));

/** The focused pane's current block (the one jumped to or clicked, else the last that ran), checked by `test`. */
function blockWhen(test?: (block: Block) => Availability) {
  return ({ layout }: ActionContext): Availability => {
    const terminal = focusedTerminal(layout);
    if (!terminal) return no("reason.noTerminal");
    const block = terminal.blocks.current();
    if (!block) return no("reason.noBlocks");
    return test ? test(block) : OK;
  };
}
const blocksOf = (ctx: ActionContext) => focusedTerminal(ctx.layout)?.blocks;
const finishedWithOutput = blockWhen((block) =>
  !isFinished(block) ? no("reason.blockRunning") : outputLineCount(block) === 0 ? no("reason.noOutput") : OK,
);

const hasSplit = (ctx: ActionContext) => {
  const tab = activeTabOf(ctx.layout);
  if (!tab) return no("reason.noTab");
  return tab.root.type === "split" ? OK : no("reason.onePane");
};

function canMove(tab: Tab | undefined, layout: LayoutState, offset: number): Availability {
  if (!tab) return no("reason.noTab");
  const index = layout.tabs.indexOf(tab);
  const pinned = layout.tabs.filter((t) => t.pinned).length;
  const [first, last] = tab.pinned ? [0, pinned - 1] : [pinned, layout.tabs.length - 1];
  const target = index + offset;
  return target >= first && target <= last ? OK : no("reason.cannotMove");
}

/** Is there a divider the focused pane can move in this direction? (Same walk as the reducer.) */
function hasDivider(layout: LayoutState, direction: Direction): boolean {
  const tab = activeTabOf(layout);
  if (!tab) return false;
  const path = pathToPane(tab.root, tab.focusedPane) ?? [];
  const axis = direction === "left" || direction === "right" ? "row" : "col";
  return path.some((_, depth) => {
    const node = nodeAt(tab.root, path.slice(0, depth));
    return node?.type === "split" && node.direction === axis;
  });
}

const DIRECTIONS: { dir: Direction; name: "Left" | "Right" | "Up" | "Down" }[] = [
  { dir: "left", name: "Left" },
  { dir: "right", name: "Right" },
  { dir: "up", name: "Up" },
  { dir: "down", name: "Down" },
];

/** Share of a split one "Move divider" step moves it. */
export const RESIZE_STEP = 0.05;

/** Below this window width the sidebar collapses and opens over the panes instead (brief 03, B4). */
export const NARROW_WIDTH = 760;

const goToTab = Array.from({ length: 8 }, (_, i): AppAction => {
  const n = i + 1;
  return {
    id: `tab.goTo${n}`,
    label: "action.tab.goTo",
    labelVars: { n },
    group: "tabs",
    hideWhenUnavailable: true,
    when: ({ layout }) => (layout.tabs.length >= n ? OK : no("reason.noTabAt", { n })),
    run: ({ dispatch }) => dispatch(layout({ type: "tab/selectIndex", index: i })),
  };
});

export const actions: AppAction[] = [
  // Tabs -------------------------------------------------------------------------------------------------------
  {
    id: "window.new",
    label: "action.window.new",
    group: "view",
    keywords: ["open", "window"],
    run: () => {
      void windowClient().create().catch(showWindowError);
    },
  },
  {
    id: "window.close",
    label: "action.window.close",
    group: "view",
    keywords: ["quit", "window"],
    run: () => {
      void windowClient()
        .currentId()
        .then((id) => windowClient().close(id))
        .catch(showWindowError);
    },
  },
  {
    id: "tab.moveToNewWindow",
    label: "action.tab.moveToNewWindow",
    group: "tabs",
    keywords: ["move", "window", "detach"],
    when: hasTab,
    run: (ctx) => {
      void windowClient()
        .create()
        .then(async (id) => {
          try {
            await moveTabToWindow(ctx, id);
          } catch (error) {
            await windowClient().close(id).catch(showWindowError);
            throw error;
          }
        })
        .catch(showWindowError);
    },
  },
  {
    id: "tab.moveToWindow",
    label: "action.tab.moveToWindow",
    group: "tabs",
    keywords: ["move", "window", "other"],
    when: hasTab,
    run: ({ dispatch }) => dispatch(setWindowPickerOpen(true)),
  },
  {
    id: "tab.new",
    label: "action.tab.new",
    group: "tabs",
    keywords: ["open", "terminal", "shell"],
    run: ({ dispatch }) => dispatch(layout({ type: "tab/new" })),
  },
  {
    id: "tab.close",
    label: "action.tab.close",
    group: "tabs",
    when: hasTab,
    run: ({ dispatch, source }) => dispatch(closeTab(undefined, source === "tabStrip" ? "tab" : undefined)),
  },
  {
    id: "tab.closeOthers",
    label: "action.tab.closeOthers",
    group: "tabs",
    when: ({ layout }) => {
      const tab = activeTabOf(layout);
      if (!tab) return no("reason.noTab");
      return layout.tabs.some((t) => t.id !== tab.id && !t.pinned) ? OK : no("reason.noOtherTabs");
    },
    run: ({ dispatch }) => dispatch(closeOtherTabs()),
  },
  {
    id: "tab.next",
    label: "action.tab.next",
    group: "tabs",
    when: ({ layout }) => (layout.tabs.length > 1 ? OK : no("reason.oneTab")),
    run: ({ dispatch }) => dispatch(layout({ type: "tab/selectRelative", offset: 1 })),
  },
  {
    id: "tab.previous",
    label: "action.tab.previous",
    group: "tabs",
    when: ({ layout }) => (layout.tabs.length > 1 ? OK : no("reason.oneTab")),
    run: ({ dispatch }) => dispatch(layout({ type: "tab/selectRelative", offset: -1 })),
  },
  ...goToTab,
  {
    id: "tab.goToLast",
    label: "action.tab.goToLast",
    group: "tabs",
    when: hasTab,
    run: ({ dispatch }) => dispatch(layout({ type: "tab/selectIndex", index: -1 })),
  },
  {
    id: "tab.moveLeft",
    label: "action.tab.moveLeft",
    group: "tabs",
    keywords: ["reorder"],
    when: ({ layout }) => canMove(activeTabOf(layout), layout, -1),
    run: ({ dispatch }) => dispatch(layout({ type: "tab/move", offset: -1 })),
  },
  {
    id: "tab.moveRight",
    label: "action.tab.moveRight",
    group: "tabs",
    keywords: ["reorder"],
    when: ({ layout }) => canMove(activeTabOf(layout), layout, 1),
    run: ({ dispatch }) => dispatch(layout({ type: "tab/move", offset: 1 })),
  },
  {
    id: "tab.rename",
    label: "action.tab.rename",
    group: "tabs",
    keywords: ["title"],
    when: hasTab,
    run: ({ dispatch, layout: state }) => dispatch(setRenamingTab(state.activeTab)),
  },
  {
    id: "tab.pin",
    label: "action.tab.pin",
    labelFor: ({ layout }) => (activeTabOf(layout)?.pinned ? "action.tab.unpin" : "action.tab.pin"),
    group: "tabs",
    when: hasTab,
    run: ({ dispatch }) => dispatch(layout({ type: "tab/pin" })),
  },
  {
    id: "tab.reopen",
    label: "action.tab.reopen",
    group: "tabs",
    keywords: ["undo", "restore"],
    when: ({ layout }) => (layout.closedTabs.length > 0 ? OK : no("reason.noClosedTabs")),
    run: ({ dispatch }) => dispatch(layout({ type: "tab/reopen" })),
  },

  // Panes ------------------------------------------------------------------------------------------------------
  {
    id: "pane.splitRight",
    label: "action.pane.splitRight",
    group: "panes",
    keywords: ["vertical", "side"],
    when: hasTab,
    run: ({ dispatch }) => dispatch(layout({ type: "pane/split", direction: "right" })),
  },
  {
    id: "pane.splitDown",
    label: "action.pane.splitDown",
    group: "panes",
    keywords: ["horizontal", "below"],
    when: hasTab,
    run: ({ dispatch }) => dispatch(layout({ type: "pane/split", direction: "down" })),
  },
  {
    id: "pane.close",
    label: "action.pane.close",
    group: "panes",
    when: hasTab,
    run: ({ dispatch }) => dispatch(closePane()),
  },
  ...DIRECTIONS.map(
    ({ dir, name }): AppAction => ({
      id: `pane.focus${name}`,
      label: `action.pane.focus${name}` as StringKey,
      group: "panes",
      keywords: ["move", "navigate"],
      when: ({ layout }) => {
        const tab = activeTabOf(layout);
        if (!tab) return no("reason.noTab");
        return neighbor(tab, tab.focusedPane, dir) ? OK : no("reason.noPaneThere");
      },
      run: ({ dispatch }) => dispatch(layout({ type: "pane/focusDirection", direction: dir })),
    }),
  ),
  ...DIRECTIONS.map(
    ({ dir, name }): AppAction => ({
      id: `pane.resize${name}`,
      label: `action.pane.resize${name}` as StringKey,
      group: "panes",
      keywords: ["resize", "size"],
      when: ({ layout }) => (hasDivider(layout, dir) ? OK : no("reason.noDivider")),
      run: ({ dispatch }) => dispatch(layout({ type: "pane/resizeFocused", direction: dir, delta: RESIZE_STEP })),
    }),
  ),
  {
    id: "pane.equalize",
    label: "action.pane.equalize",
    group: "panes",
    keywords: ["balance", "even"],
    when: hasSplit,
    run: ({ dispatch }) => dispatch(layout({ type: "pane/equalize" })),
  },
  {
    id: "pane.zoom",
    label: "action.pane.zoom",
    labelFor: ({ layout }) => (activeTabOf(layout)?.zoomedPane ? "action.pane.unzoom" : "action.pane.zoom"),
    group: "panes",
    keywords: ["maximize", "fullscreen"],
    when: hasSplit,
    run: ({ dispatch }) => dispatch(layout({ type: "pane/zoomToggle" })),
  },

  // Terminal ---------------------------------------------------------------------------------------------------
  {
    id: "terminal.broadcast",
    label: "action.terminal.broadcastOn",
    labelFor: ({ layout, state }) =>
      state.ui.broadcast?.tabId === activeTabOf(layout)?.id
        ? "action.terminal.broadcastOff"
        : "action.terminal.broadcastOn",
    group: "terminal",
    keywords: ["type", "input", "multiple panes"],
    when: hasTab,
    run: ({ layout: state, state: root, dispatch }) => {
      const tab = activeTabOf(state);
      if (!tab) return;
      const current = root.ui.broadcast;
      const next = current?.tabId === tab.id ? null : { tabId: tab.id, paneIds: [tab.focusedPane] };
      configureBroadcastRouting(tab.id, next);
      dispatch(setBroadcast(next));
    },
  },
  {
    id: "terminal.find",
    label: "action.terminal.find",
    group: "terminal",
    keywords: ["search", "scrollback"],
    // 04-app-flow F-03: Cmd/Ctrl+F (on Windows this takes Ctrl+F, readline's forward-char, from the shell).
    when: hasTerminal,
    run: ({ layout: state }) => focusedTerminal(state)?.openSearch(),
  },
  {
    id: "terminal.findNext",
    label: "action.terminal.findNext",
    group: "terminal",
    when: hasTerminal,
    run: ({ layout: state }) => focusedTerminal(state)?.find("next"),
  },
  {
    id: "terminal.findPrevious",
    label: "action.terminal.findPrevious",
    group: "terminal",
    when: hasTerminal,
    run: ({ layout: state }) => focusedTerminal(state)?.find("previous"),
  },
  {
    id: "terminal.copy",
    label: "action.terminal.copy",
    group: "terminal",
    when: ({ layout: state }) => {
      const terminal = focusedTerminal(state);
      if (!terminal) return no("reason.noTerminal");
      return terminal.engine.hasSelection() ? OK : no("reason.noSelection");
    },
    run: ({ layout: state }) => void focusedTerminal(state)?.copySelection(),
  },
  {
    id: "terminal.paste",
    label: "action.terminal.paste",
    group: "terminal",
    when: hasTerminal,
    run: ({ layout: state }) => void focusedTerminal(state)?.pasteFromClipboard(false),
  },
  {
    id: "terminal.pastePlain",
    label: "action.terminal.pastePlain",
    group: "terminal",
    keywords: ["control characters"],
    when: hasTerminal,
    run: ({ layout: state }) => void focusedTerminal(state)?.pasteFromClipboard(true),
  },
  {
    id: "terminal.selectAll",
    label: "action.terminal.selectAll",
    group: "terminal",
    when: hasTerminal,
    run: ({ layout: state }) => focusedTerminal(state)?.engine.selectAll(),
  },
  {
    id: "terminal.fontBigger",
    label: "action.terminal.fontBigger",
    group: "terminal",
    keywords: ["zoom in", "font size", "larger"],
    when: ({ state }) => (state.settings.terminal.fontSize < FONT_SIZE.max ? OK : no("reason.fontMax")),
    run: ({ dispatch }) => dispatch(zoomFont(1)),
  },
  {
    id: "terminal.fontSmaller",
    label: "action.terminal.fontSmaller",
    group: "terminal",
    keywords: ["zoom out", "font size", "smaller"],
    when: ({ state }) => (state.settings.terminal.fontSize > FONT_SIZE.min ? OK : no("reason.fontMin")),
    run: ({ dispatch }) => dispatch(zoomFont(-1)),
  },
  {
    id: "terminal.fontReset",
    label: "action.terminal.fontReset",
    group: "terminal",
    keywords: ["zoom", "font size", "actual size"],
    run: ({ dispatch }) => dispatch(zoomFont("reset")),
  },
  {
    id: "terminal.ligatures",
    label: "action.terminal.ligaturesOn",
    labelFor: ({ state }) =>
      state.settings.terminal.ligatures ? "action.terminal.ligaturesOff" : "action.terminal.ligaturesOn",
    group: "terminal",
    keywords: ["font", "calt"],
    run: ({ dispatch, state }) => dispatch(setTerminal({ ligatures: !state.settings.terminal.ligatures })),
  },
  {
    id: "terminal.secureKeyboardEntry",
    label: "action.terminal.secureKeyboardEntryOn",
    labelFor: ({ state }) =>
      state.settings.terminal.secureKeyboardEntry
        ? "action.terminal.secureKeyboardEntryOff"
        : "action.terminal.secureKeyboardEntryOn",
    group: "terminal",
    keywords: ["security", "privacy", "keyboard", "secure input"],
    hideWhenUnavailable: true,
    when: () => (getPlatform() === "mac" && isNativeRuntime() ? OK : no("reason.noTerminal")),
    run: ({ dispatch, state }) => {
      void setSecureKeyboardEntry(!state.settings.terminal.secureKeyboardEntry)
        .then((enabled) => {
          if (enabled !== null) dispatch(setTerminal({ secureKeyboardEntry: enabled }));
        })
        .catch((error: unknown) => reportNativeCommandError("native.secureKeyboardSetFailed", error));
    },
  },

  // Command blocks (M2.2). Jumps follow iTerm2 and Warp on macOS (Cmd+Up/Down); on Windows Ctrl+Shift+Up/Down, since
  // Ctrl+Up/Down belong to the shell and Ctrl+Alt+arrows already move the pane focus.
  {
    id: "block.previous",
    label: "action.block.previous",
    group: "terminal",
    keywords: ["prompt", "command", "block", "scroll"],
    when: (ctx) => {
      const blocks = blocksOf(ctx);
      if (!blocks) return no("reason.noTerminal");
      if (!blocks.current()) return no("reason.noBlocks");
      return blocks.canJump("previous") ? OK : no("reason.noPrompt");
    },
    run: (ctx) => blocksOf(ctx)?.jump("previous"),
  },
  {
    id: "block.next",
    label: "action.block.next",
    group: "terminal",
    keywords: ["prompt", "command", "block", "scroll"],
    when: (ctx) => {
      const blocks = blocksOf(ctx);
      if (!blocks) return no("reason.noTerminal");
      if (!blocks.current()) return no("reason.noBlocks");
      return blocks.canJump("next") ? OK : no("reason.noPrompt");
    },
    run: (ctx) => blocksOf(ctx)?.jump("next"),
  },
  {
    id: "block.copyCommand",
    label: "action.block.copyCommand",
    group: "terminal",
    keywords: ["block", "clipboard"],
    when: (ctx) => {
      const available = blockWhen()(ctx);
      if (!available.ok) return available;
      return blocksOf(ctx)?.commandText() ? OK : no("reason.noCommand");
    },
    run: (ctx) => void blocksOf(ctx)?.copyCommand(),
  },
  {
    id: "block.copyOutput",
    label: "action.block.copyOutput",
    group: "terminal",
    keywords: ["block", "clipboard", "result"],
    when: finishedWithOutput,
    run: (ctx) => void blocksOf(ctx)?.copyOutput(),
  },
  {
    id: "block.selectCommand",
    label: "action.block.selectCommand",
    group: "terminal",
    keywords: ["block", "highlight"],
    when: blockWhen((block) => (block.commandLine === null ? no("reason.noCommand") : OK)),
    run: (ctx) => blocksOf(ctx)?.selectCommand(),
  },
  {
    id: "block.selectOutput",
    label: "action.block.selectOutput",
    group: "terminal",
    keywords: ["block", "highlight", "result"],
    when: finishedWithOutput,
    run: (ctx) => blocksOf(ctx)?.selectOutput(),
  },
  {
    id: "block.rerun",
    label: "action.block.rerun",
    group: "terminal",
    keywords: ["block", "repeat", "again", "run"],
    when: (ctx) => {
      const available = blockWhen((block) => (isFinished(block) ? OK : no("reason.blockRunning")))(ctx);
      if (!available.ok) return available;
      return blocksOf(ctx)?.commandText() ? OK : no("reason.noCommand");
    },
    run: (ctx) => blocksOf(ctx)?.rerun(),
  },
  {
    id: "block.collapse",
    label: "action.block.collapse",
    labelFor: (ctx) => (blocksOf(ctx)?.current()?.collapsed ? "action.block.expand" : "action.block.collapse"),
    group: "terminal",
    keywords: ["block", "fold", "hide", "expand"],
    when: finishedWithOutput,
    run: (ctx) => blocksOf(ctx)?.toggleCollapsed(),
  },
  {
    id: "block.sendToAgent",
    label: "action.block.sendToAgent",
    group: "terminal",
    keywords: ["block", "ai", "ask"],
    when: (ctx) => (ctx.layout ? OK : no("reason.noTab")),
    run: (ctx) => {
      const api = blocksOf(ctx);
      const block = api?.current();
      if (!api || !block) return;
      const command = api.commandText(block.id) ?? "";
      const sessionIds = Object.values(ctx.state.agentSessions.sessions)
        .filter((s) => s.status !== "exited" && s.pane_id)
        .map((s) => s.id);
      void api.outputText(block.id).then((output) => {
        const body = (output?.text ?? "").split("\n").slice(-200).join("\n");
        ctx.dispatch(
          openPromptBar({
            text: `\`\`\`\n$ ${command}\n${body}\n\`\`\`\n\n`,
            agentSessionIds: sessionIds,
          }),
        );
      });
    },
  },
  {
    id: "block.gutter",
    label: "action.block.gutterOff",
    labelFor: (ctx) => (blocksOf(ctx)?.gutterVisible() === false ? "action.block.gutterOn" : "action.block.gutterOff"),
    group: "terminal",
    keywords: ["block", "gutter", "dots", "marks"],
    when: hasTerminal,
    run: (ctx) => blocksOf(ctx)?.toggleGutter(),
  },

  // Projects and tasks (M5.2, M5.3) ----------------------------------------------------------------------------
  {
    id: "project.add",
    label: "action.project.add",
    group: "projects",
    keywords: ["folder", "repo", "clone", "git"],
    run: ({ dispatch }) => dispatch(setProjectDialog({ kind: "addProject" })),
  },
  {
    id: "task.new",
    label: "action.task.new",
    group: "projects",
    keywords: ["worktree", "branch", "agent"],
    // 03-UI-UX S-04: Cmd/Ctrl+Shift+N.
    when: ({ state }) => (state.projects.order.length > 0 ? OK : no("reason.noProjects")),
    run: ({ dispatch, state }) => {
      const taskId = currentTaskId(state);
      const projectId = (taskId && state.projects.tasks[taskId]?.project_id) || state.projects.order[0] || null;
      dispatch(requestNewTask(projectId));
    },
  },
  {
    id: "task.archive",
    label: "action.task.archive",
    labelFor: ({ state }) => {
      const id = currentTaskId(state);
      return id && state.projects.tasks[id]?.state === "archived" ? "action.task.restore" : "action.task.archive";
    },
    group: "projects",
    keywords: ["restore", "done", "close"],
    when: ({ state }) => (currentTaskId(state) ? OK : no("reason.noTask")),
    run: ({ dispatch, state }) => {
      const id = currentTaskId(state);
      if (!id) return;
      void dispatch(state.projects.tasks[id]?.state === "archived" ? restoreTaskAction(id) : archiveTaskAction(id));
    },
  },
  {
    id: "review.toggle",
    label: "action.review.toggle",
    group: "projects",
    keywords: ["review", "diff", "changes"],
    when: ({ state }) => (currentTaskId(state) ? OK : no("reason.noTask")),
    run: () => toggleReview(),
  },
  {
    id: "task.openInEditor",
    label: "action.task.openInEditor",
    group: "projects",
    keywords: ["editor", "code", "vscode", "cursor", "zed", "open"],
    when: ({ state }) => (currentTaskId(state) ? OK : no("reason.noTask")),
    run: ({ dispatch, state }) => {
      const id = currentTaskId(state);
      if (id) void dispatch(openTaskInEditorAction(id));
    },
  },
  {
    id: "task.runScript",
    label: "action.task.runScript",
    group: "projects",
    keywords: ["run", "script", "dev", "server", "test"],
    when: ({ state }) => {
      const id = currentTaskId(state);
      const projectId = id ? state.projects.tasks[id]?.project_id : undefined;
      if (!id) return no("reason.noTask");
      return projectId && state.projects.scripts[projectId]?.length ? OK : no("task.noScripts");
    },
    run: ({ dispatch, state }) => {
      const id = currentTaskId(state);
      const projectId = id ? state.projects.tasks[id]?.project_id : undefined;
      const script = projectId ? state.projects.scripts[projectId]?.[0] : undefined;
      if (id && script) void dispatch(runScriptAction(id, script));
    },
  },
  {
    id: "task.delete",
    label: "action.task.delete",
    group: "projects",
    keywords: ["remove", "worktree"],
    when: ({ state }) => (currentTaskId(state) ? OK : no("reason.noTask")),
    run: ({ dispatch, state }) => {
      const id = currentTaskId(state);
      if (id) dispatch(requestDeleteTask(id));
    },
  },
  {
    id: "task.next",
    label: "action.task.next",
    group: "projects",
    keywords: ["switch", "tab"],
    when: ({ state }) => (taskOrder(state).length > 0 ? OK : no("reason.noTasks")),
    run: ({ dispatch }) => dispatch(openRelativeTask(1)),
  },
  {
    id: "task.previous",
    label: "action.task.previous",
    group: "projects",
    keywords: ["switch", "tab"],
    when: ({ state }) => (taskOrder(state).length > 0 ? OK : no("reason.noTasks")),
    run: ({ dispatch }) => dispatch(openRelativeTask(-1)),
  },
  {
    id: "sidebar.focusSearch",
    label: "action.sidebar.focusSearch",
    group: "projects",
    keywords: ["find", "search", "filter", "sidebar"],
    run: ({ dispatch }) => {
      dispatch(layout({ type: "sidebar/show", narrow: window.innerWidth < NARROW_WIDTH }));
      requestAnimationFrame(() => window.dispatchEvent(new Event("tessera:open-filter")));
    },
  },

  // View -------------------------------------------------------------------------------------------------------
  {
    id: "view.sidebar",
    label: "action.view.sidebar",
    group: "view",
    keywords: ["projects", "hide", "show"],
    run: ({ dispatch }) => dispatch(layout({ type: "sidebar/toggle", narrow: window.innerWidth < NARROW_WIDTH })),
  },
  {
    id: "view.quickTerminal",
    label: "action.view.quickTerminal",
    group: "view",
    keywords: ["quake", "drop down", "hotkey", "dropdown", "global"],
    run: () => {
      void toggleQuickTerminal().catch(showWindowError);
    },
  },
  {
    id: "view.palette",
    label: "action.view.palette",
    group: "view",
    keywords: ["commands"],
    inDialog: true,
    run: ({ dispatch, state }) => dispatch(setPaletteOpen(!state.ui.paletteOpen)),
  },
  {
    id: "theme.pick",
    label: "action.theme.pick",
    group: "view",
    keywords: ["colour", "color", "scheme", "dark", "light", "appearance", "import"],
    inDialog: true,
    run: ({ dispatch, state }) => dispatch(setThemePickerOpen(!state.ui.themePickerOpen)),
  },
  {
    id: "app.settings",
    label: "action.app.settings",
    group: "view",
    keywords: ["preferences", "config", "options", "font", "theme"],
    inDialog: true,
    run: ({ dispatch, state }) => dispatch(setSettingsOpen(!state.ui.settingsOpen)),
  },
  {
    id: "agents.open",
    label: "action.agents.open",
    group: "view",
    keywords: ["catalog", "profiles", "claude", "codex", "gemini", "opencode", "install", "hooks", "permissions"],
    inDialog: true,
    run: ({ dispatch }) => {
      dispatch(setSettingsPage("agents"));
      dispatch(setSettingsOpen(true));
    },
  },
  {
    id: "cli.install",
    label: "action.cli.install",
    group: "view",
    keywords: ["cli", "command", "line", "tool", "path", "install", "terminal"],
    inDialog: true,
    run: ({ dispatch }) => {
      dispatch(setSettingsPage("general"));
      dispatch(setSettingsOpen(true));
    },
  },
  {
    id: "sync.open",
    label: "action.sync.open",
    group: "view",
    keywords: ["sync", "account", "github", "sign in", "recovery", "devices"],
    inDialog: true,
    run: ({ dispatch }) => {
      dispatch(setSettingsPage("account"));
      dispatch(setSettingsOpen(true));
    },
  },
  {
    id: "ssh.connect",
    label: "action.ssh.connect",
    group: "view",
    keywords: ["ssh", "remote", "server", "host", "connect"],
    run: ({ dispatch }) => dispatch(setSshPicker(true)),
  },
  {
    id: "agents.start",
    label: "action.agents.start",
    group: "view",
    keywords: ["agent", "launch", "run", "claude", "codex", "gemini", "task"],
    run: ({ dispatch }) => dispatch(setAgentPicker(true)),
  },
  {
    id: "agents.stop",
    label: "action.agents.stop",
    group: "view",
    keywords: ["agent", "kill", "end"],
    when: ({ state }) => (focusedAgentPane(state) ? OK : no("agents.noTaskAgent")),
    run: ({ state }) => {
      const paneId = focusedAgentPane(state);
      if (paneId) stopAgentInPane(paneId);
    },
  },
  {
    id: "agents.restart",
    label: "action.agents.restart",
    group: "view",
    keywords: ["agent", "relaunch", "again"],
    when: ({ state }) => (focusedAgentPane(state) ? OK : no("agents.noTaskAgent")),
    run: ({ state, dispatch }) => {
      const paneId = focusedAgentPane(state);
      if (paneId) void dispatch(restartAgentPane(paneId));
    },
  },
  {
    id: "agents.resume",
    label: "action.agents.resume",
    group: "view",
    keywords: ["agent", "resume", "continue"],
    when: ({ state }) => {
      const paneId = focusedAgentPane(state);
      const launch = paneId ? state.agentSessions.launches[paneId] : undefined;
      const session = launch ? state.agentSessions.sessions[launch.agent_session_id] : undefined;
      return session?.status === "exited" && session.external_session_id ? OK : no("agents.noTaskAgent");
    },
    run: ({ state, dispatch }) => {
      const paneId = focusedAgentPane(state);
      if (paneId) void dispatch(resumeAgentPane(paneId)).catch(() => {});
    },
  },
  {
    id: "app.about",
    label: "action.app.about",
    group: "view",
    keywords: ["version", "logs", "data folder", "help"],
    inDialog: true,
    run: ({ dispatch, state }) => dispatch(setAboutOpen(!state.ui.aboutOpen)),
  },
  {
    id: "updates.open",
    label: "action.updates.open",
    group: "view",
    keywords: ["update", "upgrade", "version", "release", "beta", "channel", "check"],
    inDialog: true,
    run: ({ dispatch }) => {
      dispatch(setSettingsPage("updates"));
      dispatch(setSettingsOpen(true));
    },
  },
  {
    id: "feedback.open",
    label: "action.feedback.open",
    group: "view",
    keywords: [
      "feedback",
      "report",
      "bug",
      "problem",
      "idea",
      "feature",
      "suggestion",
      "screenshot",
      "contact",
      "help",
    ],
    inDialog: true,
    run: ({ dispatch }) => dispatch(setFeedbackOpen(true)),
  },
  {
    id: "app.whatsNew",
    label: "action.app.whatsNew",
    group: "view",
    keywords: ["release notes", "changes", "changelog", "new"],
    inDialog: true,
    run: ({ dispatch, state }) => dispatch(setWhatsNewOpen(!state.ui.whatsNewOpen)),
  },
  {
    id: "view.board",
    label: "action.view.board",
    group: "view",
    keywords: ["board", "kanban", "columns", "tasks", "backlog", "running", "review"],
    when: (ctx) => (Object.keys(ctx.state.projects.projects).length > 0 ? OK : no("reason.noProjects")),
    run: ({ dispatch, state }) => dispatch(setBoardOpen(!state.ui.boardOpen)),
  },
  {
    id: "task.groupNew",
    label: "action.task.groupNew",
    group: "projects",
    keywords: ["group", "best", "n", "agents", "compare"],
    when: (ctx) => (Object.keys(ctx.state.projects.projects).length > 0 ? OK : no("reason.noProjects")),
    run: ({ dispatch }) => dispatch(setProjectDialog({ kind: "newTaskGroup", projectId: null })),
  },
  {
    id: "task.groupCompare",
    label: "action.task.groupCompare",
    group: "projects",
    keywords: ["compare", "group", "best", "diff", "side by side"],
    when: ({ state }) => {
      const groups = Object.values(state.projects.groups);
      return groups.length > 0 ? OK : no("reason.noProjects");
    },
    run: ({ state, dispatch }) => {
      const newest = Object.values(state.projects.groups).sort((a, b) => (b.created_at ?? 0) - (a.created_at ?? 0))[0];
      if (newest) dispatch(setCompareGroup(newest.id));
    },
  },
  {
    id: "prompt.bar",
    label: "action.prompt.bar",
    group: "view",
    keywords: ["prompt", "send", "agent", "message"],
    inDialog: true,
    run: ({ dispatch }) => dispatch(openPromptBar()),
  },
  {
    id: "prompt.library",
    label: "action.prompt.library",
    group: "view",
    keywords: ["prompt", "library", "snippets", "templates"],
    inDialog: true,
    run: ({ dispatch, state }) => dispatch(setPromptLibraryOpen(!state.ui.promptLibraryOpen)),
  },
  {
    id: "attention.jump",
    label: "action.attention.jump",
    group: "view",
    keywords: ["agent", "needs", "next", "attention"],
    when: ({ state }) => (Object.keys(state.attention.agentAttention).length > 0 ? OK : no("attention.none")),
    run: ({ state, dispatch }) => {
      jumpToNextAttention(state, dispatch);
    },
  },
  {
    id: "attention.inbox",
    label: "action.attention.inbox",
    group: "view",
    keywords: ["needs", "you", "notifications", "inbox", "badge"],
    inDialog: true,
    run: ({ dispatch, state }) => dispatch(setInboxOpen(!state.ui.inboxOpen)),
  },
  {
    id: "attention.dnd",
    label: "action.attention.dnd",
    group: "view",
    keywords: ["do not disturb", "silent", "notifications", "focus"],
    inDialog: true,
    run: () => {
      toggleDnd();
    },
  },
  {
    id: "view.shortcuts",
    label: "action.view.shortcuts",
    group: "view",
    keywords: ["keys", "keyboard", "help"],
    inDialog: true,
    run: ({ dispatch, state }) => dispatch(setSheetOpen(!state.ui.sheetOpen)),
  },
];

const byId = new Map(actions.map((action) => [action.id, action]));
keymap.setKnownActions(byId.keys());

export function actionById(id: string): AppAction | undefined {
  return byId.get(id);
}

/** The context actions see: the current state and the dispatcher (the app store unless a test passes its own). */
export function context(
  source?: "tabStrip",
  target: { getState: () => RootState; dispatch: AppDispatch } = store,
): ActionContext {
  const state = target.getState();
  return { layout: state.layout, state, dispatch: target.dispatch, source };
}

export function availability(action: AppAction, ctx: ActionContext = context()): Availability {
  return action.when ? action.when(ctx) : OK;
}

export function actionLabel(action: AppAction, ctx: ActionContext = context()): string {
  return t(action.labelFor?.(ctx) ?? action.label, action.labelVars);
}

export function reasonText(available: Availability): string | null {
  return available.ok ? null : t(available.reason, available.vars);
}

/** The action's shortcuts on this platform (defaults with overrides), as strings for Kbd. */
export function shortcutsFor(action: AppAction, platform: Platform): string[] {
  return keymap.entries(action.id, platform).map((entry) => entry.keys);
}

/** The same with where each works ("tabStrip": only while focus is in the tab strip). */
export function shortcutEntries(action: AppAction, platform: Platform): { keys: string; scope?: "tabStrip" }[] {
  return keymap.entries(action.id, platform).map((entry) => ({ keys: entry.keys, scope: entry.scope }));
}

/** The shortcut shown in tooltips and menus: the first global one. */
export function primaryShortcut(id: string, platform: Platform): string | undefined {
  const entries = keymap.entries(id, platform);
  return (entries.find((entry) => entry.scope === undefined) ?? entries[0])?.keys;
}

export interface Binding {
  action: AppAction;
  keys: string;
  scope: "tabStrip" | undefined;
  /** Let the WebView handle the key (it fires the clipboard event the terminal pane listens to). */
  native: boolean;
}

/** Every shortcut on this platform with its action. */
export function bindings(platform: Platform, list: readonly AppAction[] = actions): Binding[] {
  return list.flatMap((action) =>
    keymap.entries(action.id, platform).map((entry) => ({
      action,
      keys: entry.keys,
      scope: entry.scope,
      native: entry.native === true,
    })),
  );
}

/** Runs an action if it is available; returns whether it ran. */
export function runAction(id: string, ctx: ActionContext = context()): boolean {
  const action = byId.get(id);
  if (!action || !availability(action, ctx).ok) return false;
  action.run(ctx);
  return true;
}

/** Panes in the active tab, for tests and the status bar. */
export function activePaneCount(layout: LayoutState): number {
  const tab = activeTabOf(layout);
  return tab ? paneIds(tab.root).length : 0;
}
