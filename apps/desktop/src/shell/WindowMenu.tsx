import {
  getPlatform,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  IconButton,
  Icons,
  Menu,
  MenuContent,
  MenuItem,
  MenuSeparator,
  MenuSub,
  MenuSubContent,
  MenuSubTrigger,
  MenuTrigger,
  t,
  useToast,
} from "@tessera/ui";
import { useEffect, useState } from "react";
import { primaryShortcut, runAction } from "../actions/registry";
import { useAppDispatch, useAppSelector, useAppStore } from "../store/hooks";
import {
  subscribeToTransferredTabs,
  transferTab,
  undoTabTransfer,
  windowClient,
  type WindowInfo,
} from "../native/windows";
import { setWindowPickerOpen } from "../store/uiSlice";

export function WindowMenu() {
  const dispatch = useAppDispatch();
  const store = useAppStore();
  const tabs = useAppSelector((state) => state.layout.tabs);
  const activeTab = useAppSelector((state) => state.layout.activeTab);
  const platform = getPlatform();
  const { toast } = useToast();
  const [windows, setWindows] = useState<WindowInfo[]>([]);

  const refresh = () => {
    void windowClient()
      .list()
      .then(setWindows)
      .catch((error: unknown) => toast({ kind: "error", title: t("native.windowFailed", { message: String(error) }) }));
  };

  const moveTo = async (targetId: string) => {
    const state = store.getState().layout;
    const tabId = state.activeTab;
    if (!tabId) return;
    try {
      const moved = await transferTab(state, dispatch, tabId, targetId, () => store.getState().layout);
      toast({
        kind: "success",
        title: t("window.tabMoved", { title: moved.tab.title ?? t("tab.untitled") }),
        onUndo: () =>
          void undoTabTransfer(moved.tabJson, moved.sourceId, moved.targetId).catch((error: unknown) =>
            toast({ kind: "error", title: t("native.windowFailed", { message: String(error) }) }),
          ),
      });
    } catch (error) {
      toast({ kind: "error", title: t("native.windowFailed", { message: String(error) }) });
    }
  };

  const windowList = windows.filter((window) => window.id !== "main" || windows.length > 1);
  const disabled = tabs.length === 0 || !activeTab;

  return (
    <Menu onOpenChange={(open) => open && refresh()}>
      <MenuTrigger asChild>
        <IconButton icon={Icons.PanelTop} label={t("window.menu")} size="sm" aria-label={t("window.menu")} />
      </MenuTrigger>
      <MenuContent align="start">
        <MenuItem
          icon={Icons.Plus}
          shortcut={primaryShortcut("window.new", platform)}
          onSelect={() => runAction("window.new")}
        >
          {t("action.window.new")}
        </MenuItem>
        <MenuItem
          icon={Icons.X}
          shortcut={primaryShortcut("window.close", platform)}
          onSelect={() => runAction("window.close")}
        >
          {t("action.window.close")}
        </MenuItem>
        <MenuSeparator />
        <MenuItem
          icon={Icons.MoveRight}
          shortcut={primaryShortcut("tab.moveToNewWindow", platform)}
          disabled={disabled}
          onSelect={() => runAction("tab.moveToNewWindow")}
        >
          {t("action.tab.moveToNewWindow")}
        </MenuItem>
        <MenuSub>
          <MenuSubTrigger icon={Icons.MoveRight} disabled={disabled}>
            {t("action.tab.moveToWindow")}
          </MenuSubTrigger>
          <MenuSubContent>
            {windowList.map((window) => (
              <MenuItem key={window.id} disabled={window.focused} onSelect={() => void moveTo(window.id)}>
                {window.title || window.id}
              </MenuItem>
            ))}
            {windowList.length === 0 && <MenuItem disabled>{t("window.noOtherWindows")}</MenuItem>}
          </MenuSubContent>
        </MenuSub>
        <MenuSeparator />
        <MenuItem
          shortcut={primaryShortcut("tab.moveToWindow", platform)}
          onSelect={() => runAction("tab.moveToWindow")}
        >
          {t("window.chooseDestination")}
        </MenuItem>
      </MenuContent>
    </Menu>
  );
}

export function WindowPickerHost() {
  const open = useAppSelector((state) => state.ui.windowPickerOpen);
  const dispatch = useAppDispatch();
  const store = useAppStore();
  const { toast } = useToast();
  const [windows, setWindows] = useState<WindowInfo[]>([]);

  useEffect(() => {
    let active = true;
    let stop: (() => void) | null = null;
    void subscribeToTransferredTabs(
      () => store.getState().layout,
      dispatch,
      (error) => toast({ kind: "error", title: t("native.windowFailed", { message: String(error) }) }),
    )
      .then((unsubscribe) => {
        if (active) stop = unsubscribe;
        else unsubscribe();
      })
      .catch((error: unknown) => toast({ kind: "error", title: t("native.windowFailed", { message: String(error) }) }));
    return () => {
      active = false;
      stop?.();
    };
  }, [dispatch, store, toast]);

  useEffect(() => {
    if (!open) return;
    let active = true;
    void windowClient()
      .list()
      .then((items) => {
        if (active) setWindows(items);
      })
      .catch((error: unknown) => toast({ kind: "error", title: t("native.windowFailed", { message: String(error) }) }));
    return () => {
      active = false;
    };
  }, [open, toast]);

  if (!open) return null;
  const moveTo = async (targetId: string) => {
    try {
      const state = store.getState().layout;
      const tabId = state.activeTab;
      if (!tabId) return;
      const moved = await transferTab(state, dispatch, tabId, targetId, () => store.getState().layout);
      dispatch(setWindowPickerOpen(false));
      toast({
        kind: "success",
        title: t("window.tabMoved", { title: moved.tab.title ?? t("tab.untitled") }),
        onUndo: () =>
          void undoTabTransfer(moved.tabJson, moved.sourceId, moved.targetId).catch((error: unknown) =>
            toast({ kind: "error", title: t("native.windowFailed", { message: String(error) }) }),
          ),
      });
    } catch (error) {
      toast({ kind: "error", title: t("native.windowFailed", { message: String(error) }) });
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => dispatch(setWindowPickerOpen(next))}>
      <DialogContent className="max-w-md">
        <DialogTitle>{t("window.chooseDestination")}</DialogTitle>
        <DialogDescription>{t("window.chooseDestinationHint")}</DialogDescription>
        <ul className="max-h-64 space-y-1 overflow-auto">
          {windows.map((window) => (
            <li key={window.id}>
              <button
                type="button"
                disabled={window.focused}
                onClick={() => void moveTo(window.id)}
                className="w-full rounded px-3 py-2 text-start hover:bg-surface-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-50"
              >
                {window.title || window.id}
              </button>
            </li>
          ))}
          {windows.length < 2 && <li className="px-3 py-2 text-muted">{t("window.noOtherWindows")}</li>}
        </ul>
        <div className="mt-4 flex justify-end">
          <Button onClick={() => dispatch(setWindowPickerOpen(false))}>{t("confirm.cancel")}</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
