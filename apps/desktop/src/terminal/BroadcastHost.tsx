import { useEffect, useRef } from "react";
import { paneIds } from "../layout";
import { useAppDispatch, useAppSelector } from "../store/hooks";
import { setBroadcast, setBroadcastPanes } from "../store/uiSlice";
import { configureBroadcastRouting, isBroadcastPasteConfirmationOpen } from "./broadcast";

export function BroadcastHost() {
  const dispatch = useAppDispatch();
  const broadcast = useAppSelector((state) => state.ui.broadcast);
  const activeTab = useAppSelector((state) => state.layout.tabs.find((tab) => tab.id === state.layout.activeTab));
  const modalOpen = useAppSelector(({ ui }) =>
    Boolean(
      ui.aboutOpen ||
        ui.confirm ||
        ui.paletteOpen ||
        ui.projectDialog ||
        ui.settingsOpen ||
        ui.sheetOpen ||
        ui.themePickerOpen ||
        ui.windowPickerOpen,
    ),
  );
  const broadcastRef = useRef(broadcast);
  const activeTabIdRef = useRef(activeTab?.id ?? null);
  const modalOpenRef = useRef(modalOpen);
  broadcastRef.current = broadcast;
  activeTabIdRef.current = activeTab?.id ?? null;
  modalOpenRef.current = modalOpen;

  useEffect(() => {
    if (broadcast && broadcast.tabId !== activeTab?.id) {
      configureBroadcastRouting(activeTab?.id ?? null, null);
      dispatch(setBroadcast(null));
      return;
    }
    if (broadcast && activeTab) {
      const available = new Set(paneIds(activeTab.root));
      const paneIdsInTab = broadcast.paneIds.filter((id) => available.has(id));
      if (paneIdsInTab.length !== broadcast.paneIds.length) dispatch(setBroadcastPanes(paneIdsInTab));
      configureBroadcastRouting(activeTab.id, { ...broadcast, paneIds: paneIdsInTab });
    } else {
      configureBroadcastRouting(activeTab?.id ?? null, null);
    }
  }, [activeTab, broadcast, dispatch]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const current = broadcastRef.current;
      if (
        event.key !== "Escape" ||
        !current ||
        current.tabId !== activeTabIdRef.current ||
        modalOpenRef.current ||
        isBroadcastPasteConfirmationOpen()
      )
        return;
      event.preventDefault();
      event.stopPropagation();
      dispatch(setBroadcast(null));
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
    };
  }, [dispatch]);

  return null;
}
