// The real layout and scrollback bindings (Tauri only; browser mode and tests use the fake store).
import { commands, type SavedLayout_Serialize, unwrap, type WindowBounds_Serialize } from "@tessera/ipc";
import type { PaneId } from "../layout";
import type { LayoutBindings, SavedLayout, WindowBounds } from "./store";

function toIpcBounds(bounds: WindowBounds | null): WindowBounds_Serialize | null {
  return bounds ? { ...bounds, maximized: false } : null;
}

function fromIpc(saved: SavedLayout_Serialize): SavedLayout {
  const b = saved.bounds;
  return {
    window_id: saved.window_id,
    state: saved.state,
    bounds:
      b && b.x !== null && b.y !== null && b.w !== null && b.h !== null
        ? { x: b.x, y: b.y, w: b.w, h: b.h, monitor: b.monitor }
        : null,
    updated_at: saved.updated_at ?? 0,
  };
}

/** `layout_save`, `layout_load` and `scrollback_load` from the generated bindings. */
export function createTauriLayoutBindings(): LayoutBindings {
  return {
    async layoutSave(windowId, state, bounds) {
      await unwrap(commands.layoutSave(windowId, state, toIpcBounds(bounds)));
    },
    async layoutLoad() {
      return (await unwrap(commands.layoutLoad(null))).map(fromIpc);
    },
    scrollbackLoad(paneId: PaneId) {
      return unwrap(commands.scrollbackLoad(paneId));
    },
  };
}
