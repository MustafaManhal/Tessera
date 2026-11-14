// The tab strip (S-01, APG tabs): one tab in the tab order (roving tabindex), Left/Right/Home/End move and select
// (automatic activation: panes are already mounted), Delete closes, F2 renames, Alt+Shift+Left/Right moves the tab
// (announced in the live region), Shift+F10 or a right click opens the tab menu. Pointer: click selects, double click
// renames, middle click closes, drag reorders. When the tabs do not fit, scroll buttons and an "all tabs" menu appear.
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuRadioGroup,
  ContextMenuRadioItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
  cn,
  getPlatform,
  IconButton,
  Icons,
  Input,
  Menu,
  MenuContent,
  MenuItem,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
  t,
} from "@tessera/ui";
import { type KeyboardEvent, type PointerEvent, useEffect, useRef, useState } from "react";
import { primaryShortcut, runAction } from "../actions/registry";
import { TAB_COLORS, type Tab, type TabColor, type TabId } from "../layout";
import type { AppDispatch } from "../store";
import { useAppDispatch, useAppSelector } from "../store/hooks";
import { layout } from "../store/layoutSlice";
import { selectActiveTabId, selectClosedTabCount, selectTabs, selectTabTitles } from "../store/selectors";
import { closeOtherTabs, closeTab } from "../store/thunks";
import { requestPaneFocus, setRenamingTab } from "../store/uiSlice";
import { focusTabElement, scrollBehavior, tabElementId, tabPanelId } from "./dom";
import { TabBadge, TabProgress } from "./TabAttention";

const COLOUR_CLASS: Record<TabColor, string> = {
  red: "bg-tab-red",
  orange: "bg-tab-orange",
  yellow: "bg-tab-yellow",
  green: "bg-tab-green",
  blue: "bg-tab-blue",
  purple: "bg-tab-purple",
};

const DRAG_THRESHOLD_PX = 4;

interface DragState {
  tabId: TabId;
  pointerId: number;
  startX: number;
  dragging: boolean;
}

function selectAndFocusPane(dispatch: AppDispatch, tabId: TabId) {
  dispatch(layout({ type: "tab/select", tabId }));
  dispatch(requestPaneFocus());
}

export function TabStrip() {
  const tabs = useAppSelector(selectTabs);
  const activeTab = useAppSelector(selectActiveTabId);
  const titles = useAppSelector(selectTabTitles);
  const closedTabs = useAppSelector(selectClosedTabCount);
  const renaming = useAppSelector((state) => state.ui.renamingTab);
  const dispatch = useAppDispatch();
  const [list, setList] = useState<HTMLDivElement | null>(null);
  const [scroll, setScroll] = useState({ overflow: false, left: false, right: false });
  const [dragOffset, setDragOffset] = useState<{ tabId: TabId; dx: number } | null>(null);
  const drag = useRef<DragState | null>(null);
  const suppressClick = useRef(false);
  const platform = getPlatform();

  // Overflow: show the scroll buttons and the "all tabs" menu only when the tabs do not fit. Re-run when the tabs
  // change, to observe the new tab elements.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `tabs` is the trigger, not a value read inside.
  useEffect(() => {
    if (!list) return;
    const update = () =>
      setScroll({
        overflow: list.scrollWidth > list.clientWidth + 1,
        left: list.scrollLeft > 1,
        right: list.scrollLeft + list.clientWidth < list.scrollWidth - 1,
      });
    update();
    const observer = new ResizeObserver(update);
    observer.observe(list);
    for (const child of Array.from(list.children)) observer.observe(child);
    list.addEventListener("scroll", update, { passive: true });
    return () => {
      observer.disconnect();
      list.removeEventListener("scroll", update);
    };
  }, [list, tabs]);

  // Keep the selected tab in view.
  useEffect(() => {
    if (activeTab)
      document.getElementById(tabElementId(activeTab))?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activeTab]);

  // Keys on a tab (the rename field inside a tab handles its own).
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) return;
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const count = tabs.length;
    const index = tabs.findIndex((tab) => tab.id === activeTab);
    let next: number;
    switch (event.key) {
      case "ArrowRight":
        next = (index + 1) % count;
        break;
      case "ArrowLeft":
        next = (index - 1 + count) % count;
        break;
      case "Home":
        next = 0;
        break;
      case "End":
        next = count - 1;
        break;
      case "Enter":
      case " ":
        event.preventDefault();
        dispatch(requestPaneFocus());
        return;
      default:
        return;
    }
    event.preventDefault();
    const target = tabs[next];
    if (!target) return;
    dispatch(layout({ type: "tab/select", tabId: target.id }));
    document.getElementById(tabElementId(target.id))?.focus();
  };

  const onPointerDown = (event: PointerEvent<HTMLDivElement>, tabId: TabId) => {
    if (event.button === 1) event.preventDefault(); // no autoscroll on middle click
    if (event.button !== 0 || (event.target as HTMLElement).closest("button, input")) return;
    drag.current = { tabId, pointerId: event.pointerId, startX: event.clientX, dragging: false };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const state = drag.current;
    if (!state || state.pointerId !== event.pointerId) return;
    const dx = event.clientX - state.startX;
    if (!state.dragging && Math.abs(dx) < DRAG_THRESHOLD_PX) return;
    state.dragging = true;
    setDragOffset({ tabId: state.tabId, dx });
  };

  const onPointerUp = (event: PointerEvent<HTMLDivElement>) => {
    const state = drag.current;
    drag.current = null;
    setDragOffset(null);
    if (!state?.dragging || !list) return;
    // The drop index: how many of the other tabs have their middle before the pointer.
    const others = Array.from(list.querySelectorAll<HTMLElement>('[role="tab"]')).filter(
      (element) => element.dataset.tabId !== state.tabId,
    );
    const toIndex = others.filter((element) => {
      const rect = element.getBoundingClientRect();
      return rect.left + rect.width / 2 < event.clientX;
    }).length;
    dispatch(layout({ type: "tab/reorder", tabId: state.tabId, toIndex }));
    dispatch(layout({ type: "tab/select", tabId: state.tabId }));
    suppressClick.current = true;
    requestAnimationFrame(() => {
      suppressClick.current = false;
    });
  };

  const scrollBy = (direction: -1 | 1) =>
    list?.scrollBy({ left: direction * list.clientWidth * 0.8, behavior: scrollBehavior() });

  const title = (tab: Tab) => titles[tab.id] ?? t("tab.untitled");

  return (
    <div className="flex min-w-0 shrink items-stretch">
      {scroll.overflow && (
        <div className="flex items-center px-0.5">
          <IconButton
            icon={Icons.ChevronLeft}
            label={t("tab.scrollLeft")}
            size="sm"
            disabled={!scroll.left}
            onClick={() => scrollBy(-1)}
          />
        </div>
      )}
      <div
        ref={setList}
        role="tablist"
        aria-label={t("tabs.label")}
        className="no-scrollbar flex min-w-0 shrink overflow-x-auto"
      >
        {tabs.map((tab) => {
          const active = tab.id === activeTab;
          const offset = dragOffset?.tabId === tab.id ? dragOffset.dx : 0;
          return (
            <ContextMenu key={tab.id}>
              <ContextMenuTrigger asChild>
                <div
                  role="tab"
                  id={tabElementId(tab.id)}
                  data-tab-id={tab.id}
                  aria-selected={active}
                  aria-controls={tabPanelId(tab.id)}
                  aria-haspopup="menu"
                  tabIndex={active ? 0 : -1}
                  title={title(tab)}
                  className={cn(
                    "group relative flex h-8 w-56 min-w-30 shrink cursor-default items-center gap-1.5 border-e border-border",
                    "ps-3 pe-1 text-sm select-none",
                    active ? "bg-bg text-fg" : "bg-surface text-muted hover:bg-surface-2 hover:text-fg",
                    offset !== 0 && "z-10 bg-surface-2 shadow-popover",
                  )}
                  style={offset !== 0 ? { transform: `translateX(${offset}px)` } : undefined}
                  onPointerDown={(event) => onPointerDown(event, tab.id)}
                  onPointerMove={onPointerMove}
                  onPointerUp={onPointerUp}
                  onPointerCancel={() => {
                    drag.current = null;
                    setDragOffset(null);
                  }}
                  onClick={() => {
                    if (!suppressClick.current && renaming !== tab.id) selectAndFocusPane(dispatch, tab.id);
                  }}
                  onKeyDown={onKeyDown}
                  onDoubleClick={() => dispatch(setRenamingTab(tab.id))}
                  onAuxClick={(event) => {
                    if (event.button === 1) dispatch(closeTab(tab.id));
                  }}
                >
                  {active && <span aria-hidden className="absolute inset-x-0 top-0 h-0.5 bg-accent-ink" />}
                  {tab.color && (
                    <span aria-hidden className={cn("size-2 shrink-0 rounded-full", COLOUR_CLASS[tab.color])} />
                  )}
                  {tab.pinned && <Icons.Pin size={14} className="shrink-0 text-muted" aria-hidden />}
                  <TabProgress tab={tab} />
                  {renaming === tab.id ? (
                    <RenameInput tab={tab} initial={title(tab)} />
                  ) : (
                    <span className="min-w-0 flex-1 truncate">
                      {title(tab)}
                      {tab.pinned && <span className="sr-only">, {t("tab.pinnedState")}</span>}
                    </span>
                  )}
                  <TabBadge tab={tab} />
                  {!tab.pinned && renaming !== tab.id && (
                    <IconButton
                      icon={Icons.X}
                      label={t("action.tab.close")}
                      shortcut={primaryShortcut("tab.close", platform)}
                      size="sm"
                      tabIndex={-1}
                      className={cn("shrink-0", !active && "opacity-0 group-hover:opacity-100 focus:opacity-100")}
                      onPointerDown={(event) => event.stopPropagation()}
                      onClick={(event) => {
                        event.stopPropagation();
                        dispatch(closeTab(tab.id));
                      }}
                    />
                  )}
                </div>
              </ContextMenuTrigger>
              <TabMenu tab={tab} closedTabs={closedTabs} />
            </ContextMenu>
          );
        })}
      </div>
      {scroll.overflow && (
        <div className="flex items-center gap-1 px-1">
          <IconButton
            icon={Icons.ChevronRight}
            label={t("tab.scrollRight")}
            size="sm"
            disabled={!scroll.right}
            onClick={() => scrollBy(1)}
          />
          <Menu>
            <MenuTrigger asChild>
              <IconButton icon={Icons.ChevronDown} label={t("tab.allTabs")} size="sm" />
            </MenuTrigger>
            <MenuContent align="end" className="max-w-80">
              <MenuRadioGroup value={activeTab ?? ""} onValueChange={(tabId) => selectAndFocusPane(dispatch, tabId)}>
                {tabs.map((tab) => (
                  <MenuRadioItem key={tab.id} value={tab.id}>
                    <span className="flex min-w-0 items-center gap-2">
                      {tab.color && (
                        <span aria-hidden className={cn("size-2 shrink-0 rounded-full", COLOUR_CLASS[tab.color])} />
                      )}
                      <span className="truncate">{title(tab)}</span>
                    </span>
                  </MenuRadioItem>
                ))}
              </MenuRadioGroup>
              <MenuSeparator />
              <MenuItem
                icon={Icons.RotateCcw}
                shortcut={primaryShortcut("tab.reopen", platform)}
                disabled={closedTabs === 0}
                onSelect={() => runAction("tab.reopen")}
              >
                {t("action.tab.reopen")}
              </MenuItem>
            </MenuContent>
          </Menu>
        </div>
      )}
      <div className="flex items-center px-1">
        <IconButton
          icon={Icons.Plus}
          label={t("action.tab.new")}
          shortcut={primaryShortcut("tab.new", platform)}
          size="sm"
          onClick={() => runAction("tab.new")}
        />
      </div>
    </div>
  );
}

function TabMenu({ tab, closedTabs }: { tab: Tab; closedTabs: number }) {
  const platform = getPlatform();
  const dispatch = useAppDispatch();
  const shortcut = (id: string) => primaryShortcut(id, platform);
  return (
    <ContextMenuContent>
      <ContextMenuItem
        icon={Icons.Pencil}
        shortcut={shortcut("tab.rename")}
        onSelect={() => {
          dispatch(layout({ type: "tab/select", tabId: tab.id }));
          dispatch(setRenamingTab(tab.id));
        }}
      >
        {t("action.tab.rename")}
      </ContextMenuItem>
      <ContextMenuSub>
        <ContextMenuSubTrigger icon={Icons.Palette}>{t("tab.colour")}</ContextMenuSubTrigger>
        <ContextMenuSubContent>
          <ContextMenuRadioGroup
            value={tab.color ?? "none"}
            onValueChange={(value) =>
              dispatch(
                layout({ type: "tab/setColor", tabId: tab.id, color: value === "none" ? null : (value as TabColor) }),
              )
            }
          >
            <ContextMenuRadioItem value="none">{t("tab.colour.none")}</ContextMenuRadioItem>
            {TAB_COLORS.map((colour) => (
              <ContextMenuRadioItem key={colour} value={colour}>
                <span className="flex items-center gap-2">
                  <span aria-hidden className={cn("size-2 rounded-full", COLOUR_CLASS[colour])} />
                  {t(`tab.colour.${colour}`)}
                </span>
              </ContextMenuRadioItem>
            ))}
          </ContextMenuRadioGroup>
        </ContextMenuSubContent>
      </ContextMenuSub>
      <ContextMenuItem
        icon={tab.pinned ? Icons.PinOff : Icons.Pin}
        shortcut={shortcut("tab.pin")}
        onSelect={() => dispatch(layout({ type: "tab/pin", tabId: tab.id }))}
      >
        {t(tab.pinned ? "action.tab.unpin" : "action.tab.pin")}
      </ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem icon={Icons.X} shortcut={shortcut("tab.close")} onSelect={() => dispatch(closeTab(tab.id))}>
        {t("action.tab.close")}
      </ContextMenuItem>
      <ContextMenuItem shortcut={shortcut("tab.closeOthers")} onSelect={() => dispatch(closeOtherTabs(tab.id))}>
        {t("action.tab.closeOthers")}
      </ContextMenuItem>
      <ContextMenuItem
        icon={Icons.RotateCcw}
        shortcut={shortcut("tab.reopen")}
        disabled={closedTabs === 0}
        onSelect={() => runAction("tab.reopen")}
      >
        {t("action.tab.reopen")}
      </ContextMenuItem>
    </ContextMenuContent>
  );
}

function RenameInput({ tab, initial }: { tab: Tab; initial: string }) {
  const done = useRef(false);
  const dispatch = useAppDispatch();
  const finish = (title: string | null) => {
    if (done.current) return;
    done.current = true;
    if (title !== null) dispatch(layout({ type: "tab/rename", tabId: tab.id, title }));
    dispatch(setRenamingTab(null));
    focusTabElement(tab.id);
  };
  return (
    <Input
      aria-label={t("tab.renameLabel")}
      defaultValue={initial}
      autoFocus
      onFocus={(event) => event.currentTarget.select()}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          finish(event.currentTarget.value);
        } else if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          finish(null);
        }
      }}
      onBlur={(event) => finish(event.currentTarget.value)}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
      className="h-6 min-w-0 flex-1 px-1 text-sm"
    />
  );
}
