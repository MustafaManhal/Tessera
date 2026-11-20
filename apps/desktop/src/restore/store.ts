// LayoutStore: where window layouts and pane scrollback are saved behind one interface.
// Browser mode and tests use FakeLayoutStore; the Tauri adapter implements the planned IPC contract.
import type { LayoutJson } from "../layout";
import type { PaneId } from "../layout";

export interface WindowBounds {
  x: number;
  y: number;
  w: number;
  h: number;
  monitor: string | null;
}

/** One saved window. `state` is whatever was stored: it goes through `parseLayout`, which repairs or refuses it. */
export interface SavedLayout {
  window_id: string;
  state: unknown;
  bounds: WindowBounds | null;
  updated_at: number;
}

export interface LayoutStore {
  save(windowId: string, state: LayoutJson, bounds: WindowBounds | null): Promise<void>;
  load(): Promise<SavedLayout[]>;
  loadScrollback(paneId: PaneId): Promise<Uint8Array | null>;
}

/** Planned worker-1 binding shape; layout state is opaque JSON and scrollback is a byte vector. */
export interface LayoutBindings {
  layoutSave(windowId: string, state: string, bounds: WindowBounds | null): Promise<void>;
  layoutLoad(): Promise<SavedLayout[]>;
  /** Raw bytes: an `ArrayBuffer` from the real backend (the generated type says `number[]`), a plain array in tests. */
  scrollbackLoad(paneId: PaneId): Promise<ArrayBuffer | number[]>;
}

const STORAGE_KEY = "tessera.layouts";

export class FakeLayoutStore implements LayoutStore {
  private readonly memory = new Map<string, SavedLayout>();
  /** Saves received, in order (tests). */
  readonly saves: { windowId: string; state: LayoutJson }[] = [];
  /** Make `load` fail (tests). */
  failLoad: Error | null = null;

  constructor(
    private readonly persist = false,
    private readonly now: () => number = Date.now,
  ) {}

  async save(windowId: string, state: LayoutJson, bounds: WindowBounds | null): Promise<void> {
    this.saves.push({ windowId, state });
    const entry: SavedLayout = { window_id: windowId, state, bounds, updated_at: this.now() };
    this.memory.set(windowId, entry);
    if (this.persist) {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify([...this.memory.values()]));
      } catch {
        // Blocked or full storage: the layout lives for this session only.
      }
    }
  }

  async load(): Promise<SavedLayout[]> {
    if (this.failLoad) throw this.failLoad;
    if (this.persist) {
      let raw: string | null = null;
      try {
        raw = localStorage.getItem(STORAGE_KEY);
      } catch {
        return [];
      }
      if (raw === null) return [];
      try {
        const parsed: unknown = JSON.parse(raw);
        if (Array.isArray(parsed)) return parsed as SavedLayout[];
      } catch {
        // Corrupt file: hand the raw text over as the window's layout, so the restore reports it and starts fresh.
      }
      return [{ window_id: "main", state: raw, bounds: null, updated_at: 0 }];
    }
    return [...this.memory.values()];
  }

  async loadScrollback(_paneId: PaneId): Promise<Uint8Array | null> {
    return null;
  }
}

export class TauriLayoutStore implements LayoutStore {
  constructor(private readonly bindings: LayoutBindings) {}

  async save(windowId: string, state: LayoutJson, bounds: WindowBounds | null): Promise<void> {
    await this.bindings.layoutSave(windowId, JSON.stringify(state), bounds);
  }

  load(): Promise<SavedLayout[]> {
    return this.bindings.layoutLoad();
  }

  async loadScrollback(paneId: PaneId): Promise<Uint8Array | null> {
    const raw = await this.bindings.scrollbackLoad(paneId);
    const bytes = new Uint8Array(raw as ArrayBuffer);
    return bytes.length > 0 ? bytes : null;
  }
}
