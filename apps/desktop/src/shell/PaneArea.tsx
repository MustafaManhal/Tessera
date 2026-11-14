// The pane area: every pane of every tab, positioned from the split tree. Panes are rendered flat (keyed by pane id,
// absolutely positioned from computed rects) rather than nested per split node, so splitting, closing, swapping,
// zooming or switching tabs never remounts a pane's content: a terminal keeps its state. Panes of other tabs stay
// mounted but hidden.
import {
  Button,
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
  cn,
  EmptyState,
  getPlatform,
  Icons,
  t,
  Tooltip,
} from "@tessera/ui";
import { type CSSProperties, useEffect, useMemo, useRef, useState } from "react";
import { actionById, actionLabel, availability, primaryShortcut, runAction } from "../actions/registry";
import { agentPaneExited, agentPaneOutput, agentPaneSpawned } from "../agents/launch";
import { layoutGeometry, type PaneNode, paneIds, paneTitle, type Rect, type Tab } from "../layout";
import { Divider } from "./Divider";
import { paneElementId, type Size, tabElementId, tabPanelId, useElementSize } from "./dom";
import type { PaneContentComponent, PaneContentHandle } from "./pane/PaneContent";
import { useAppDispatch, useAppSelector } from "../store/hooks";
import { layout } from "../store/layoutSlice";
import { selectActiveTabId, selectTabs } from "../store/selectors";
import { closePane } from "../store/thunks";
import { setBroadcast, setBroadcastPanes } from "../store/uiSlice";
import { usePtyClient } from "../terminal/ptyClient";

const toPercent = (rect: Rect): CSSProperties => ({
  left: `${rect.x * 100}%`,
  top: `${rect.y * 100}%`,
  width: `${rect.w * 100}%`,
  height: `${rect.h * 100}%`,
});

// Buttons on the red broadcast banner: the banner's own text colour on a darker tint, with an outline, so they read
// clearly on the red in both themes (the plain button background was dark text on a dark fill).
const BROADCAST_BUTTON =
  "border border-danger-fg/50 bg-danger-fg/10 text-danger-fg hover:bg-danger-fg/20 data-[state=open]:bg-danger-fg/20";

export function PaneArea({ content }: { content: PaneContentComponent }) {
  const tabs = useAppSelector(selectTabs);
  const activeTab = useAppSelector(selectActiveTabId);
  const [element, setElement] = useState<HTMLDivElement | null>(null);
  const area = useElementSize(element);
  const dim = useAppSelector((state) => state.settings.paneDimUnfocused);
  const broadcast = useAppSelector((state) => state.ui.broadcast);
  const dispatch = useAppDispatch();
  const active = tabs.find((tab) => tab.id === activeTab);

  return (
    <div
      ref={setElement}
      className="relative min-h-0 min-w-0 flex-1 overflow-hidden bg-term-bg"
      style={{ "--pane-dim": dim } as CSSProperties}
    >
      {active && broadcast?.tabId === active.id && (
        <div
          role="status"
          aria-live="polite"
          className="absolute inset-x-2 top-2 z-40 flex min-h-9 items-center gap-2 rounded-md bg-danger px-3 py-1 text-sm text-danger-fg shadow-popover"
        >
          <span className="min-w-0 flex-1 font-medium">
            {t("broadcast.banner", { count: broadcast.paneIds.length })}
          </span>
          <Button
            size="sm"
            variant="ghost"
            className={BROADCAST_BUTTON}
            onClick={() => dispatch(setBroadcastPanes(paneIds(active.root)))}
          >
            {t("broadcast.selectAll")}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className={BROADCAST_BUTTON}
            aria-keyshortcuts="Escape"
            onClick={() => dispatch(setBroadcast(null))}
          >
            {t("broadcast.stopHint")}
          </Button>
        </div>
      )}
      {tabs.map((tab) => (
        <TabPanes key={tab.id} tab={tab} active={tab.id === activeTab} area={area} content={content} />
      ))}
      {tabs.length === 0 && (
        <EmptyState
          className="h-full"
          icon={Icons.SquareTerminal}
          message={t("shell.noTabs")}
          action={{ label: t("action.tab.new"), icon: Icons.Plus, onClick: () => runAction("tab.new") }}
        />
      )}
    </div>
  );
}

interface TabPanesProps {
  tab: Tab;
  active: boolean;
  area: Size;
  content: PaneContentComponent;
}

function TabPanes({ tab, active, area, content }: TabPanesProps) {
  const geometry = useMemo(() => layoutGeometry(tab.root), [tab.root]);
  const panes = useMemo(() => collectPanes(tab), [tab]);
  const zoomed = tab.zoomedPane;
  const multi = panes.length > 1;
  const platform = getPlatform();
  const dispatch = useAppDispatch();

  return (
    <div
      role="tabpanel"
      id={tabPanelId(tab.id)}
      aria-labelledby={tabElementId(tab.id)}
      hidden={!active}
      className="absolute inset-0"
    >
      {panes.map((pane, index) => {
        const rect = geometry.panes.get(pane.id);
        if (!rect) return null;
        const hiddenByZoom = zoomed !== null && zoomed !== pane.id;
        return (
          <PaneFrame
            key={pane.id}
            tab={tab}
            pane={pane}
            index={index}
            count={panes.length}
            style={zoomed === pane.id ? toPercent({ x: 0, y: 0, w: 1, h: 1 }) : toPercent(rect)}
            hidden={hiddenByZoom}
            visible={active && !hiddenByZoom}
            ring={multi && zoomed === null}
            content={content}
          />
        );
      })}
      {zoomed === null &&
        geometry.dividers.map((divider) => (
          <Divider key={`${divider.splitId}:${divider.index}`} tab={tab} divider={divider} area={area} />
        ))}
      {zoomed !== null && (
        <div className="absolute end-3 top-8 z-20 flex items-center gap-2 rounded-md border border-border bg-surface py-1 ps-2 pe-1 text-sm shadow-popover">
          <Icons.Maximize2 size={14} className="text-muted" aria-hidden />
          <span className="font-medium">{t("pane.zoomed")}</span>
          <Tooltip label={t("action.pane.unzoom")} shortcut={primaryShortcut("pane.zoom", platform)}>
            <Button size="sm" icon={Icons.Minimize2} onClick={() => dispatch(layout({ type: "pane/zoomToggle" }))}>
              {t("pane.showAll")}
            </Button>
          </Tooltip>
        </div>
      )}
    </div>
  );
}

/** The block actions in the pane menu (the same ones as the gutter menu, with full-size targets). */
const BLOCK_MENU = [
  "block.previous",
  "block.next",
  "block.copyCommand",
  "block.copyOutput",
  "block.selectCommand",
  "block.selectOutput",
  "block.rerun",
  "block.collapse",
  "block.sendToAgent",
  "block.gutter",
];

function collectPanes(tab: Tab): PaneNode[] {
  const out: PaneNode[] = [];
  const walk = (node: Tab["root"]) => {
    if (node.type === "pane") out.push(node);
    else node.children.forEach(walk);
  };
  walk(tab.root);
  // Keep a stable DOM order (by id) so a swap or split never reorders, and so never remounts, a pane.
  return out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

interface PaneFrameProps {
  tab: Tab;
  pane: PaneNode;
  index: number;
  count: number;
  style: CSSProperties;
  hidden: boolean;
  visible: boolean;
  /** Show the focus ring on the focused pane (more than one pane on screen). */
  ring: boolean;
  content: PaneContentComponent;
}

function PaneFrame({ tab, pane, count, style, hidden, visible, ring, content: Content }: PaneFrameProps) {
  const info = useAppSelector((state) => state.layout.panes[pane.id]);
  const isActiveTab = useAppSelector((state) => state.layout.activeTab === tab.id);
  const focusRequest = useAppSelector((state) => state.ui.paneFocusRequest);
  const ligatures = useAppSelector((state) => state.settings.terminal.ligatures);
  const broadcast = useAppSelector((state) => state.ui.broadcast);
  const dispatch = useAppDispatch();
  const pty = usePtyClient();
  const handle = useRef<PaneContentHandle>(null);
  const focused = tab.focusedPane === pane.id;
  const attention = useAppSelector((state) => state.attention.agentAttention[pane.id]);
  const platform = getPlatform();

  // Move keyboard focus into this pane when a focus request arrives and this is the focused pane of the active tab.
  // Only a new request acts: becoming active or visible on its own (arrowing through the tab strip) must not take
  // the focus away from where the user is.
  const target = useRef({ focused, isActiveTab, visible });
  target.current = { focused, isActiveTab, visible };
  useEffect(() => {
    const now = target.current;
    if (focusRequest > 0 && now.focused && now.isActiveTab && now.visible) handle.current?.focus();
  }, [focusRequest]);

  if (!info) return null;
  const order = paneIds(tab.root).indexOf(pane.id) + 1;
  const label = t("pane.label", { index: order, count, title: paneTitle(info) ?? t("tab.untitled") });
  const shortcut = (id: string) => primaryShortcut(id, platform);

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <section
          id={paneElementId(pane.id)}
          aria-label={label}
          data-pane-id={pane.id}
          data-focused={focused}
          hidden={hidden}
          className="absolute overflow-hidden"
          style={style}
          onPointerDown={() => {
            if (!focused || !isActiveTab) dispatch(layout({ type: "pane/focus", paneId: pane.id }));
          }}
        >
          {isActiveTab && broadcast?.tabId === tab.id && (
            <label
              className="absolute end-2 top-12 z-30 flex cursor-pointer items-center gap-1.5 rounded-md border border-border bg-surface px-2 py-1 text-xs text-fg shadow-popover"
              onPointerDown={(event) => event.stopPropagation()}
            >
              <input
                type="checkbox"
                aria-label={t("broadcast.selectPane", { index: order })}
                checked={broadcast.paneIds.includes(pane.id)}
                onChange={(event) => {
                  const selected = new Set(broadcast.paneIds);
                  if (event.currentTarget.checked) selected.add(pane.id);
                  else selected.delete(pane.id);
                  dispatch(setBroadcastPanes([...selected]));
                }}
                className="accent-accent"
              />
              {t("broadcast.pane", { index: order })}
            </label>
          )}
          <Content
            ref={handle}
            tabId={tab.id}
            paneId={pane.id}
            kind={pane.kind}
            sessionId={pane.sessionId}
            info={info}
            focused={focused}
            visible={visible}
            onFocused={() => {
              if (!focused || !isActiveTab) dispatch(layout({ type: "pane/focus", paneId: pane.id }));
            }}
            onCwdChange={(cwd) => dispatch(layout({ type: "pane/setCwd", paneId: pane.id, cwd }))}
            onTitleChange={(title) => dispatch(layout({ type: "pane/setTitle", paneId: pane.id, title }))}
            onRunningProcessChange={(process) =>
              dispatch(layout({ type: "pane/setProcess", paneId: pane.id, process }))
            }
            onSpawned={(sessionId) => {
              if (!pty) return;
              void dispatch(
                agentPaneSpawned({
                  paneId: pane.id,
                  paneSessionId: sessionId,
                  write: (text) => pty.write(sessionId, new TextEncoder().encode(text)),
                }),
              );
            }}
            onOutput={(bytes) => agentPaneOutput(pane.id, bytes)}
            onExit={(code) => void dispatch(agentPaneExited(pane.id, code))}
          />
          {!focused && (
            <div aria-hidden className="pointer-events-none absolute inset-0 bg-term-bg opacity-(--pane-dim)" />
          )}
          {focused && ring && (
            <div aria-hidden className={cn("pane-focus-ring pointer-events-none absolute inset-0")} />
          )}
          {attention && (
            <div
              aria-hidden
              data-attention-ring={attention.kind}
              className="attention-ring pointer-events-none absolute inset-0"
            />
          )}
        </section>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem
          icon={Icons.Columns2}
          shortcut={shortcut("pane.splitRight")}
          onSelect={() => dispatch(layout({ type: "pane/split", paneId: pane.id, direction: "right" }))}
        >
          {t("action.pane.splitRight")}
        </ContextMenuItem>
        <ContextMenuItem
          icon={Icons.Rows2}
          shortcut={shortcut("pane.splitDown")}
          onSelect={() => dispatch(layout({ type: "pane/split", paneId: pane.id, direction: "down" }))}
        >
          {t("action.pane.splitDown")}
        </ContextMenuItem>
        {count > 1 && (
          <>
            <ContextMenuItem
              icon={tab.zoomedPane ? Icons.Minimize2 : Icons.Maximize2}
              shortcut={shortcut("pane.zoom")}
              onSelect={() => dispatch(layout({ type: "pane/zoomToggle", paneId: pane.id }))}
            >
              {t(tab.zoomedPane ? "action.pane.unzoom" : "action.pane.zoom")}
            </ContextMenuItem>
            <ContextMenuItem
              icon={Icons.Equal}
              shortcut={shortcut("pane.equalize")}
              onSelect={() => dispatch(layout({ type: "pane/equalize" }))}
            >
              {t("action.pane.equalize")}
            </ContextMenuItem>
          </>
        )}
        <ContextMenuSeparator />
        <ContextMenuItem
          icon={Icons.ZoomIn}
          shortcut={shortcut("terminal.fontBigger")}
          onSelect={() => runAction("terminal.fontBigger")}
        >
          {t("action.terminal.fontBigger")}
        </ContextMenuItem>
        <ContextMenuItem
          icon={Icons.ZoomOut}
          shortcut={shortcut("terminal.fontSmaller")}
          onSelect={() => runAction("terminal.fontSmaller")}
        >
          {t("action.terminal.fontSmaller")}
        </ContextMenuItem>
        <ContextMenuItem shortcut={shortcut("terminal.fontReset")} onSelect={() => runAction("terminal.fontReset")}>
          {t("action.terminal.fontReset")}
        </ContextMenuItem>
        <ContextMenuItem
          icon={Icons.Ligature}
          shortcut={shortcut("terminal.ligatures")}
          onSelect={() => runAction("terminal.ligatures")}
        >
          {t(ligatures ? "action.terminal.ligaturesOff" : "action.terminal.ligaturesOn")}
        </ContextMenuItem>
        <ContextMenuSub>
          <ContextMenuSubTrigger icon={Icons.SquareChevronRight}>{t("block.menu")}</ContextMenuSubTrigger>
          <ContextMenuSubContent>
            {BLOCK_MENU.map((id) => {
              const action = actionById(id);
              if (!action) return null;
              return (
                <ContextMenuItem
                  key={id}
                  shortcut={shortcut(id)}
                  disabled={!availability(action).ok}
                  onSelect={() => runAction(id)}
                >
                  {actionLabel(action)}
                </ContextMenuItem>
              );
            })}
          </ContextMenuSubContent>
        </ContextMenuSub>
        <ContextMenuSeparator />
        <ContextMenuItem icon={Icons.X} shortcut={shortcut("pane.close")} onSelect={() => dispatch(closePane(pane.id))}>
          {t("action.pane.close")}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
