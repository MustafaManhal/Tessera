import type { BroadcastState } from "../store/uiSlice";
import { paneTerminal } from "./panes";

interface BroadcastRouting {
  activeTabId: string | null;
  broadcast: BroadcastState | null;
  pasteConfirmationOpen: boolean;
}

let routing: BroadcastRouting = {
  activeTabId: null,
  broadcast: null,
  pasteConfirmationOpen: false,
};
const pasteConfirmations = new Set<string>();

export function configureBroadcastRouting(activeTabId: string | null, broadcast: BroadcastState | null): void {
  routing = { ...routing, activeTabId, broadcast };
}

export function setBroadcastPasteConfirmation(paneId: string, open: boolean): void {
  if (open) pasteConfirmations.add(paneId);
  else pasteConfirmations.delete(paneId);
  routing = { ...routing, pasteConfirmationOpen: pasteConfirmations.size > 0 };
}

export function isBroadcastPasteConfirmationOpen(): boolean {
  return routing.pasteConfirmationOpen;
}

/** Routes a focused pane's terminal bytes only to members of the active tab's broadcast set. */
export function broadcastInput(tabId: string, bytes: Uint8Array): boolean {
  const { activeTabId, broadcast, pasteConfirmationOpen } = routing;
  if (!broadcast || broadcast.tabId !== tabId || activeTabId !== tabId) return false;
  if (pasteConfirmationOpen) return true;
  for (const target of broadcast.paneIds) paneTerminal(target)?.writeInput(bytes);
  return true;
}
