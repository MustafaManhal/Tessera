// The left sidebar region (S-02 comes later): collapsible (Mod+B), resizable 200–420 px with a pointer or the arrow
// keys (width kept in the layout store, in memory only for now). Below 760 px it collapses and opens over the panes
// instead, closing on Esc or a click outside.
import { Button, cn, getPlatform, IconButton, Icons, t } from "@tessera/ui";
import { type KeyboardEvent, type PointerEvent, useRef } from "react";
import { SIDEBAR_WIDTH } from "../layout";
import { primaryShortcut, runAction } from "../actions/registry";
import { InboxButton } from "../notify/InboxPanel";
import { ProjectTree } from "../sidebar/ProjectTree";
import { useAppDispatch, useAppSelector, useAppStore } from "../store/hooks";
import { layout } from "../store/layoutSlice";
import { selectSidebar } from "../store/selectors";

const STEP_PX = 8;
const BIG_STEP_PX = 40;

/** The always-visible entries at the foot of the sidebar: icon and label, so they are easy to find. */
const FOOTER = [
  { action: "app.settings", icon: Icons.Settings, label: "settings.title" },
  { action: "feedback.open", icon: Icons.MessageSquarePlus, label: "action.feedback.open" },
  { action: "app.about", icon: Icons.Info, label: "action.app.about" },
  { action: "view.shortcuts", icon: Icons.Keyboard, label: "action.view.shortcuts" },
] as const;

export function Sidebar({ narrow }: { narrow: boolean }) {
  const { width, hidden, overlayOpen } = useAppSelector(selectSidebar);
  const dispatch = useAppDispatch();
  const platform = getPlatform();
  const open = narrow ? overlayOpen : !hidden;
  if (!open) return null;

  return (
    <>
      {narrow && (
        // A click outside the overlay closes it.
        <div
          aria-hidden
          className="absolute inset-0 z-20"
          onPointerDown={() => dispatch(layout({ type: "sidebar/closeOverlay" }))}
        />
      )}
      <aside
        id="sidebar"
        aria-label={t("sidebar.label")}
        className={cn(
          "relative flex shrink-0 flex-col border-e border-border bg-linear-to-b from-accent-wash to-surface",
          narrow && "absolute inset-y-0 start-0 z-30 shadow-popover",
        )}
        style={{ width }}
        onKeyDown={(event) => {
          if (narrow && event.key === "Escape") dispatch(layout({ type: "sidebar/closeOverlay" }));
        }}
      >
        <ProjectTree
          title={t("sidebar.projects")}
          filterTrailing={
            <IconButton
              size="sm"
              icon={Icons.FolderPlus}
              label={t("sidebar.addProject")}
              shortcut={primaryShortcut("project.add", platform)}
              onClick={() => runAction("project.add")}
            />
          }
        />
        <nav aria-label={t("settings.title")} className="flex shrink-0 flex-col gap-0.5 border-t border-border p-2">
          <InboxButton labeled />
          {FOOTER.map((entry) => (
            <Button
              key={entry.action}
              variant="ghost"
              icon={entry.icon}
              data-sidebar-footer={entry.action}
              className="w-full justify-start"
              title={primaryShortcut(entry.action, platform) || undefined}
              onClick={() => runAction(entry.action)}
            >
              {t(entry.label)}
            </Button>
          ))}
        </nav>
        <SidebarResizer width={width} />
      </aside>
    </>
  );
}

function SidebarResizer({ width }: { width: number }) {
  const drag = useRef<{ startX: number; startWidth: number } | null>(null);
  const dispatch = useAppDispatch();
  const store = useAppStore();
  const rtl = () => document.documentElement.dir === "rtl";

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    event.currentTarget.focus({ preventScroll: true });
    drag.current = { startX: event.clientX, startWidth: store.getState().layout.sidebar.width };
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    const moved = (event.clientX - drag.current.startX) * (rtl() ? -1 : 1);
    dispatch(layout({ type: "sidebar/setWidth", width: drag.current.startWidth + moved }));
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? BIG_STEP_PX : STEP_PX;
    const grow = rtl() ? "ArrowLeft" : "ArrowRight";
    const shrink = rtl() ? "ArrowRight" : "ArrowLeft";
    let next: number;
    if (event.key === grow) next = width + step;
    else if (event.key === shrink) next = width - step;
    else if (event.key === "Home") next = SIDEBAR_WIDTH.min;
    else if (event.key === "End") next = SIDEBAR_WIDTH.max;
    else return;
    event.preventDefault();
    dispatch(layout({ type: "sidebar/setWidth", width: next }));
  };

  return (
    // biome-ignore lint/a11y/useSemanticElements: an <hr> cannot take focus or pointer drags; APG uses a separator role.
    <div
      role="separator"
      tabIndex={0}
      aria-orientation="vertical"
      aria-label={t("sidebar.resize")}
      aria-controls="sidebar"
      aria-valuemin={SIDEBAR_WIDTH.min}
      aria-valuemax={SIDEBAR_WIDTH.max}
      aria-valuenow={width}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={() => {
        drag.current = null;
      }}
      onPointerCancel={() => {
        drag.current = null;
      }}
      onKeyDown={onKeyDown}
      className="group absolute inset-y-0 -end-1 z-10 flex w-2 cursor-col-resize touch-none justify-center outline-offset-0"
    >
      <span aria-hidden className="pointer-events-none h-full w-px bg-transparent group-hover:bg-border-strong" />
    </div>
  );
}
