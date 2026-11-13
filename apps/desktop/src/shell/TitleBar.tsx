// The title bar row (03-UI-UX §3: "title bar + tab strip", 32 px): the sidebar toggle, the tab strip, an empty drag
// area for moving the window (`data-tauri-drag-region`), and the pane and palette buttons. Every button's tooltip
// shows its shortcut from the registry.
import { getPlatform, IconButton, Icons, type LucideIcon, t } from "@tessera/ui";
import { useEffect, useState } from "react";
import { primaryShortcut, runAction } from "../actions/registry";
import { setWindowTitle } from "../native/window";
import { isNativeRuntime } from "../native/runtime";
import { minimizeCurrentWindow, toggleCurrentWindowMaximize } from "../native/windows";
import { IdeButton } from "../panels/IdeButton";
import { useAppDispatch, useAppSelector } from "../store/hooks";
import { toggleSidePanel } from "../store/uiSlice";
import { selectSidebar } from "../store/selectors";
import logoUrl from "../assets/icon/tessera.svg";
import { TabStrip } from "./TabStrip";
import { WindowMenu } from "./WindowMenu";

export function TitleBar({ narrow }: { narrow: boolean }) {
  const platform = getPlatform();
  const sidebar = useAppSelector(selectSidebar);
  const hasTabs = useAppSelector((state) => state.layout.tabs.length > 0);
  const sidePanel = useAppSelector((state) => state.ui.sidePanel);
  const dispatch = useAppDispatch();
  const activeTab = useAppSelector((state) => state.layout.tabs.find((tab) => tab.id === state.layout.activeTab));
  const paneInfo = useAppSelector((state) => (activeTab ? state.layout.panes[activeTab.focusedPane] : undefined));
  const task = useAppSelector((state) => (paneInfo?.taskId ? state.projects.tasks[paneInfo.taskId] : undefined));
  const project = useAppSelector((state) => (task ? state.projects.projects[task.project_id] : undefined));
  const sidebarOpen = narrow ? sidebar.overlayOpen : !sidebar.hidden;
  const [maximized, setMaximized] = useState(false);
  const [customFrame, setCustomFrame] = useState(!isNativeRuntime());
  // In full screen macOS hides the traffic lights, so the space kept free for them is given back.
  const [fullscreen, setFullscreen] = useState(false);

  useEffect(() => {
    const pane = activeTab ? paneInfo?.programTitle || paneInfo?.cwd.split(/[\\/]/).filter(Boolean).at(-1) : null;
    const title = [project?.name, task?.name, activeTab?.title || pane, "Tessera"].filter(Boolean).join(" — ");
    void setWindowTitle(title);
  }, [activeTab, paneInfo, project?.name, task?.name]);

  useEffect(() => {
    if (platform !== "mac" || !isNativeRuntime()) return;
    let active = true;
    let stop: (() => void) | null = null;
    void import("@tauri-apps/api/window")
      .then(async ({ getCurrentWindow }) => {
        const current = getCurrentWindow();
        const update = () => void current.isFullscreen().then((value) => active && setFullscreen(value));
        update();
        stop = await current.onResized(update);
        if (!active) stop();
      })
      .catch(() => {});
    return () => {
      active = false;
      stop?.();
    };
  }, [platform]);

  useEffect(() => {
    if (platform !== "windows") return;
    let active = true;
    void import("@tauri-apps/api/window")
      .then(async ({ getCurrentWindow }) => {
        const current = getCurrentWindow();
        const [isMaximized, isDecorated] = await Promise.all([current.isMaximized(), current.isDecorated()]);
        if (active) {
          setMaximized(isMaximized);
          setCustomFrame(!isDecorated);
        }
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [platform]);
  const button = (id: string, icon: LucideIcon, label: string, disabled = false) => (
    <IconButton
      icon={icon}
      label={label}
      shortcut={primaryShortcut(id, platform)}
      size="sm"
      disabled={disabled}
      onClick={() => runAction(id)}
    />
  );

  const toggleMaximize = async () => {
    try {
      setMaximized(await toggleCurrentWindowMaximize());
    } catch {
      // The window may be closing while the native button is pressed.
    }
  };
  const mac = platform === "mac";
  const windows = platform === "windows" && customFrame;

  return (
    <header data-tauri-drag-region className="flex h-8 shrink-0 items-stretch border-b border-border bg-surface">
      <div className={`flex items-center px-1 ${mac && !fullscreen ? "ps-20" : ""}`}>
        <button
          type="button"
          aria-label={t("action.view.sidebar")}
          title={primaryShortcut("view.sidebar", platform) || undefined}
          aria-expanded={sidebarOpen}
          aria-controls="sidebar"
          data-sidebar-toggle
          className="group/logo flex h-6 cursor-pointer items-center gap-1.5 rounded-md border-0 bg-transparent px-1.5 text-fg hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-focus"
          onClick={() => runAction("view.sidebar")}
        >
          {/* The logo is the sidebar button's face; pointing at it (or focusing it) shows the sidebar icon instead. */}
          <span className="relative grid size-5 shrink-0 place-items-center">
            <img
              src={logoUrl}
              alt=""
              width={20}
              height={20}
              className="size-5 rounded-[5px] group-hover/logo:opacity-0 group-focus-visible/logo:opacity-0"
            />
            <Icons.PanelLeft
              size={16}
              aria-hidden
              className="absolute opacity-0 group-hover/logo:opacity-100 group-focus-visible/logo:opacity-100"
            />
          </span>
          <span className="text-sm font-semibold tracking-tight max-sm:hidden" aria-hidden>
            Tessera
          </span>
        </button>
      </div>
      <TabStrip />
      <div data-tauri-drag-region className="min-w-6 flex-1" />
      <div className="flex items-center gap-0.5 px-1">
        <IdeButton />
        <IconButton
          icon={Icons.GitCompare}
          label={t("panel.changes")}
          size="sm"
          aria-pressed={sidePanel === "changes"}
          data-panel-toggle="changes"
          disabled={!hasTabs}
          onClick={() => dispatch(toggleSidePanel("changes"))}
        />
        <IconButton
          icon={Icons.FolderTree}
          label={t("panel.files")}
          size="sm"
          aria-pressed={sidePanel === "files"}
          data-panel-toggle="files"
          disabled={!hasTabs}
          onClick={() => dispatch(toggleSidePanel("files"))}
        />
        {button("view.palette", Icons.Command, t("action.view.palette"))}
        <WindowMenu />
      </div>
      {windows && (
        <div className="ms-1 flex shrink-0">
          <button
            type="button"
            aria-label={t("window.minimize")}
            title={t("window.minimize")}
            onClick={() => void minimizeCurrentWindow()}
            className="grid w-11 place-items-center hover:bg-surface-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
          >
            <Icons.Minus size={14} aria-hidden />
          </button>
          <button
            type="button"
            aria-label={t(maximized ? "window.restore" : "window.maximize")}
            title={t(maximized ? "window.restore" : "window.maximize")}
            onClick={() => void toggleMaximize()}
            className="grid w-11 place-items-center hover:bg-surface-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
          >
            {maximized ? <Icons.Copy size={12} aria-hidden /> : <Icons.Square size={12} aria-hidden />}
          </button>
          <button
            type="button"
            aria-label={t("action.window.close")}
            title={t("action.window.close")}
            onClick={() => runAction("window.close")}
            className="grid w-11 place-items-center hover:bg-danger focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
          >
            <Icons.X size={14} aria-hidden />
          </button>
        </div>
      )}
    </header>
  );
}
