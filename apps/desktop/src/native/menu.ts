import { commands, events, unwrap } from "@tessera/ipc";
import { getPlatform, type Platform } from "@tessera/ui";
import { actionLabel, actions, primaryShortcut, runAction, type ActionGroup } from "../actions/registry";
import { keymap } from "../actions/keymap";
import { reportNativeCommandError } from "./errors";
import { isNativeRuntime } from "./runtime";

type Unsubscribe = () => void;

export interface NativeMenuItem {
  id: string;
  label: string;
  accelerator: string;
  group: ActionGroup;
}

export interface MenuClient {
  setItems(items: NativeMenuItem[]): Promise<void>;
  onAction(listener: (id: string) => void): Promise<Unsubscribe>;
}

export interface NativeMenuBindings {
  menuSet(items: NativeMenuItem[]): Promise<void>;
  onMenuAction(listener: (id: string) => void): Promise<Unsubscribe>;
}

export class NativeMenuClient implements MenuClient {
  constructor(private readonly bindings: NativeMenuBindings) {}

  setItems(items: NativeMenuItem[]): Promise<void> {
    return this.bindings.menuSet(items);
  }

  onAction(listener: (id: string) => void): Promise<Unsubscribe> {
    return this.bindings.onMenuAction(listener);
  }
}

export class FakeMenuClient implements MenuClient {
  items: NativeMenuItem[] = [];
  setCount = 0;
  private readonly listeners = new Set<(id: string) => void>();

  async setItems(items: NativeMenuItem[]): Promise<void> {
    this.items = items.map((item) => ({ ...item }));
    this.setCount += 1;
  }

  async onAction(listener: (id: string) => void): Promise<Unsubscribe> {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emitAction(id: string): void {
    for (const listener of this.listeners) listener(id);
  }
}

/** The native menu in the Tauri app; browser and tests use the in-memory adapter. */
export function createMenuClient(): MenuClient {
  if (!isNativeRuntime()) return new FakeMenuClient();
  return new NativeMenuClient({
    async menuSet(items) {
      await unwrap(commands.menuSet(items));
    },
    onMenuAction(listener) {
      return events.menuAction.listen((event) => listener(event.payload.id));
    },
  });
}

export function nativeMenuItems(platform: Platform = getPlatform()): NativeMenuItem[] {
  return actions.flatMap((action) => {
    const accelerator = primaryShortcut(action.id, platform);
    return accelerator ? [{ id: action.id, label: actionLabel(action), accelerator, group: action.group }] : [];
  });
}

export function startNativeMenu(
  client: MenuClient,
  platform: Platform = getPlatform(),
  executeAction: (id: string) => boolean = runAction,
): Unsubscribe {
  let stopped = false;
  let unlisten: Unsubscribe | null = null;
  const updateItems = () => {
    void client.setItems(nativeMenuItems(platform)).catch((error: unknown) => {
      reportNativeCommandError("native.menuFailed", error);
    });
  };
  updateItems();
  const stopKeymap = keymap.subscribe(updateItems);
  void client
    .onAction((id) => {
      if (!stopped) executeAction(id);
    })
    .then((stop) => {
      if (stopped) stop();
      else unlisten = stop;
    })
    .catch((error: unknown) => reportNativeCommandError("native.menuFailed", error));
  return () => {
    stopped = true;
    stopKeymap();
    unlisten?.();
  };
}
