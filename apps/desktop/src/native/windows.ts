import { emitTo } from "@tauri-apps/api/event";
import { t } from "@tessera/ui";
import { commands, events, unwrap } from "@tessera/ipc";
import { paneIds, parseLayout, serializeLayout, type LayoutState, type Tab, type TabId } from "../layout";
import type { AppDispatch } from "../store";
import { layout } from "../store/layoutSlice";
import { paneTerminal } from "../terminal/panes";
import { detachTransferredPanes, drainTransferAttaches, transferReadiness } from "../terminal/transferState";
import { isNativeRuntime } from "./runtime";

export interface WindowInfo {
  id: string;
  title: string;
  focused: boolean;
}

type TransferAck = { id: string; from: string; ok: boolean; cancelled?: boolean };
type TransferMessage =
  | { operation: "offer"; id: string; tabJson: string }
  | { operation: "cancel" | "commit"; id: string }
  | { operation: "undo"; tabId: string };

export interface WindowClient {
  currentId(): Promise<string>;
  create(): Promise<string>;
  list(): Promise<WindowInfo[]>;
  close(id: string): Promise<void>;
  transfer(from: string, to: string, tabJson: string): Promise<void>;
  acknowledge(to: string, ack: TransferAck): Promise<void>;
  onAcknowledged(listener: (ack: TransferAck) => void): Promise<() => void>;
  onTransferred(listener: (event: { from: string; to: string; tabJson: string }) => void): Promise<() => void>;
}

const nativeClient: WindowClient = {
  async currentId() {
    if (!isNativeRuntime()) return "main";
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    return getCurrentWindow().label;
  },
  async create() {
    if (!isNativeRuntime()) {
      const child = window.open(window.location.href, "_blank");
      if (!child) throw new Error("The new window was blocked by the browser");
      return "browser-window";
    }
    return unwrap(await commands.windowNew());
  },
  async list() {
    if (!isNativeRuntime()) return [{ id: "main", title: document.title, focused: true }];
    return unwrap(await commands.windowList());
  },
  async close(id) {
    if (!isNativeRuntime()) {
      window.close();
      return;
    }
    await unwrap(commands.windowClose(id));
  },
  async transfer(from, to, tabJson) {
    if (!isNativeRuntime()) throw new Error("Moving tabs between windows requires the desktop app");
    await unwrap(commands.windowTransferTab(from, to, tabJson));
  },
  acknowledge(to, ack) {
    return emitTo(to, "tab:transfer-ack", ack);
  },
  async onAcknowledged(listener) {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    return getCurrentWindow().listen<TransferAck>("tab:transfer-ack", ({ payload }) => listener(payload));
  },
  async onTransferred(listener) {
    if (!isNativeRuntime()) return () => {};
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    return events
      .tabTransferred(getCurrentWindow())
      .listen((event) => listener({ from: event.payload.from, to: event.payload.to, tabJson: event.payload.tab_json }));
  },
};

let client: WindowClient = nativeClient;

export function setWindowClient(next: WindowClient): () => void {
  const previous = client;
  client = next;
  return () => {
    client = previous;
  };
}

export function windowClient(): WindowClient {
  return client;
}

export async function minimizeCurrentWindow(): Promise<void> {
  if (!isNativeRuntime()) return;
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  await getCurrentWindow().minimize();
}

export async function toggleCurrentWindowMaximize(): Promise<boolean> {
  if (!isNativeRuntime()) return false;
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  const current = getCurrentWindow();
  const maximized = await current.isMaximized();
  if (maximized) await current.unmaximize();
  else await current.maximize();
  return !maximized;
}

export async function maximizeCurrentWindow(): Promise<void> {
  if (!isNativeRuntime()) return;
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  const current = getCurrentWindow();
  if (!(await current.isMaximized())) await current.maximize();
}

export function tabTransferJson(state: LayoutState, tabId: TabId): string {
  const tab = state.tabs.find((candidate) => candidate.id === tabId);
  if (!tab) throw new Error("The tab is no longer open");
  const ids = paneIds(tab.root);
  const panes = Object.fromEntries(ids.flatMap((id) => (state.panes[id] ? [[id, state.panes[id]]] : [])));
  const saved = serializeLayout({ ...state, tabs: [tab], activeTab: tab.id, panes, closedTabs: [] });
  const sessions = Object.fromEntries(ids.map((id) => [id, paneTerminal(id)?.transferSession() ?? {}]));
  return JSON.stringify({ ...saved, sessions });
}

export function insertTransferredTab(state: LayoutState, tabJson: string): LayoutState {
  const parsed = parseLayout(tabJson);
  if (!parsed.ok) throw new Error(`The transferred tab is invalid: ${parsed.error}`);
  if (parsed.value.tabs.length !== 1) throw new Error("A transfer must contain exactly one tab");
  const incoming = parsed.value;
  const tab = incoming.tabs[0];
  if (!tab || state.tabs.some((current) => current.id === tab.id)) return state;
  const paneIdSet = new Set(Object.keys(state.panes));
  if (paneIds(tab.root).some((id) => paneIdSet.has(id))) {
    throw new Error("The transferred tab conflicts with an open pane");
  }
  return {
    ...state,
    tabs: [...state.tabs, tab],
    activeTab: tab.id,
    panes: { ...state.panes, ...incoming.panes },
  };
}

export function removeTransferredTab(state: LayoutState, tabId: TabId): LayoutState {
  const tab = state.tabs.find((candidate) => candidate.id === tabId);
  if (!tab) return state;
  const index = state.tabs.indexOf(tab);
  const tabs = state.tabs.filter((candidate) => candidate.id !== tabId);
  const paneInfo = { ...state.panes };
  for (const id of paneIds(tab.root)) delete paneInfo[id];
  const activeTab = state.activeTab === tabId ? (tabs[Math.min(index, tabs.length - 1)]?.id ?? null) : state.activeTab;
  return { ...state, tabs, activeTab, panes: paneInfo };
}

const TRANSFER_TIMEOUT = 5000;
const moving = new Set<string>();

function sessionPayload(tabJson: string): Record<string, { sessionId?: string; exitCode?: number }> {
  const { sessions } = JSON.parse(tabJson) as { sessions?: unknown };
  if (sessions === undefined) return {};
  if (!sessions || typeof sessions !== "object" || Array.isArray(sessions))
    throw new Error(t("window.transferInvalid"));
  const result: Record<string, { sessionId?: string; exitCode?: number }> = Object.create(null);
  for (const [id, session] of Object.entries(sessions)) {
    if (!session || typeof session !== "object" || Array.isArray(session)) throw new Error(t("window.transferInvalid"));
    const { sessionId, exitCode } = session;
    if (
      (sessionId !== undefined && (typeof sessionId !== "string" || !sessionId)) ||
      (exitCode !== undefined && !Number.isInteger(exitCode)) ||
      (sessionId !== undefined && exitCode !== undefined)
    )
      throw new Error(t("window.transferInvalid"));
    result[id] = { sessionId, exitCode };
  }
  return result;
}

function replace(dispatch: AppDispatch, state: LayoutState, focus: "pane" | "none" = "none") {
  dispatch(layout({ type: "layout/replace", state }, focus));
}

export async function transferTab(
  state: LayoutState,
  dispatch: AppDispatch,
  tabId: TabId,
  targetId: string,
  getLayout: () => LayoutState = () => state,
  transport: WindowClient = client,
): Promise<{ sourceId: string; targetId: string; tab: Tab; tabJson: string }> {
  const sourceId = await transport.currentId();
  if (sourceId === targetId) throw new Error(t("window.transferSame"));
  const key = JSON.stringify([sourceId, tabId]);
  if (moving.has(key)) throw new Error(t("window.transferPending"));
  const source = getLayout();
  const tab = source.tabs.find((candidate) => candidate.id === tabId);
  if (!tab) throw new Error(t("window.transferMissing"));
  if (paneIds(tab.root).some((paneId) => source.panes[paneId]?.transfer?.pending)) {
    throw new Error(t("window.transferPending"));
  }
  const tabJson = tabTransferJson(source, tabId);
  const sessions = sessionPayload(tabJson);
  const id = crypto.randomUUID();
  const send = (message: TransferMessage) => transport.transfer(sourceId, targetId, JSON.stringify(message));
  moving.add(key);
  let unsubscribe: (() => void) | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let retry: ReturnType<typeof setInterval> | undefined;
  let offered = false;
  let cancelled: () => void = () => {};
  const cancellation = new Promise<void>((resolve) => {
    cancelled = resolve;
  });
  try {
    let acknowledge: (ok: boolean) => void = () => {};
    const response = new Promise<boolean>((resolve) => {
      acknowledge = resolve;
    });
    unsubscribe = await transport.onAcknowledged((ack) => {
      if (ack.id !== id || ack.from !== targetId) return;
      if (ack.cancelled) cancelled();
      else acknowledge(ack.ok);
    });
    const deadline = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => reject(new Error(t("window.transferTimeout"))), TRANSFER_TIMEOUT);
    });
    offered = true;
    const offer = () => send({ operation: "offer", id, tabJson });
    // A newly created webview may still be mounting its event listener.
    retry = setInterval(() => {
      void offer().catch(() => {});
    }, 250);
    const ok = await Promise.race([offer().then(() => response), deadline]);
    clearInterval(retry);
    if (!ok) throw new Error(t("window.transferRejected"));
    const current = getLayout();
    if (current.tabs.find((item) => item.id === tabId)?.root !== tab.root) throw new Error(t("window.transferChanged"));
    clearTimeout(timeout);
    await send({ operation: "commit", id });
    detachTransferredPanes(paneIds(tab.root));
    replace(dispatch, removeTransferredTab(getLayout(), tabId));
    return { sourceId, targetId, tab, tabJson };
  } catch (error) {
    clearInterval(retry);
    if (offered) {
      let cancelTimeout: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          send({ operation: "cancel", id }).then(() => cancellation),
          new Promise<void>((resolve) => {
            cancelTimeout = setTimeout(resolve, 1000);
          }),
        ]);
      } catch {
        // A closed destination cannot confirm its cleanup.
      } finally {
        clearTimeout(cancelTimeout);
      }
      await Promise.allSettled(
        Object.entries(sessions).flatMap(([paneId, session]) => {
          const terminal = paneTerminal(paneId);
          return terminal && session.sessionId ? [terminal.reclaimSession(session.sessionId)] : [];
        }),
      );
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    unsubscribe?.();
    moving.delete(key);
  }
}

/** Undo asks the current owner to initiate a fresh transfer back with its current pane sessions. */
export async function undoTabTransfer(tabJson: string, sourceId: string, targetId: string): Promise<void> {
  const parsed = parseLayout(tabJson);
  const tabId = parsed.ok ? parsed.value.tabs[0]?.id : undefined;
  if (!tabId) throw new Error(t("window.transferInvalid"));
  await client.transfer(sourceId, targetId, JSON.stringify({ operation: "undo", tabId } satisfies TransferMessage));
}

export async function subscribeToTransferredTabs(
  getLayout: () => LayoutState,
  dispatch: AppDispatch,
  reportError: (error: unknown) => void,
  transport: WindowClient = client,
): Promise<() => void> {
  const finished = new Set<string>();
  const finish = (id: string) => {
    finished.add(id);
    if (finished.size > 128) finished.delete(finished.values().next().value!);
  };
  const incoming = new Map<string, { tabId: TabId; from: string; timer: ReturnType<typeof setTimeout> }>();
  const cancel = (id: string) => {
    finish(id);
    const pending = incoming.get(id);
    if (!pending) return;
    clearTimeout(pending.timer);
    incoming.delete(id);
    transferReadiness.delete(id);
    const state = getLayout();
    const tab = state.tabs.find((item) => item.id === pending.tabId);
    if (tab) detachTransferredPanes(paneIds(tab.root));
    replace(dispatch, removeTransferredTab(state, pending.tabId));
  };
  const stop = await transport.onTransferred(({ from, to, tabJson }) => {
    const receive = async () => {
      const message = JSON.parse(tabJson) as TransferMessage;
      if (message.operation === "undo") {
        await transferTab(getLayout(), dispatch, message.tabId, from, getLayout, transport);
        return;
      }
      if (message.operation === "cancel" || message.operation === "commit") {
        const pending = incoming.get(message.id);
        if (message.operation === "cancel") {
          if (pending && pending.from !== from) return;
          cancel(message.id);
          await drainTransferAttaches(message.id);
          await transport.acknowledge(from, { id: message.id, from: to, ok: false, cancelled: true });
          return;
        }
        if (pending?.from !== from) return;
        clearTimeout(pending.timer);
        finish(message.id);
        incoming.delete(message.id);
        transferReadiness.delete(message.id);
        const state = getLayout();
        const panes = { ...state.panes };
        for (const [id, pane] of Object.entries(panes)) {
          if (pane.transfer?.id === message.id) panes[id] = { ...pane, transfer: { ...pane.transfer, pending: false } };
        }
        replace(dispatch, { ...state, panes }, "pane");
        return;
      }
      if (message.operation !== "offer" || typeof message.id !== "string" || typeof message.tabJson !== "string") {
        throw new Error(t("window.transferInvalid"));
      }
      const { id } = message;
      if (incoming.has(id) || finished.has(id)) return;
      const reply = (ok: boolean) => transport.acknowledge(from, { id, from: to, ok });
      try {
        const current = getLayout();
        const next = insertTransferredTab(current, message.tabJson);
        if (next === current) throw new Error(t("window.transferRejected"));
        const tab = next.tabs.find((tab) => tab.id === next.activeTab);
        if (!tab) throw new Error(t("window.transferInvalid"));
        const sessions = sessionPayload(message.tabJson);
        const awaiting = new Set<string>();
        for (const paneId of paneIds(tab.root)) {
          const session = sessions[paneId];
          if (session?.sessionId) awaiting.add(paneId);
          next.panes[paneId] = { ...next.panes[paneId]!, transfer: { ...session, id, pending: true } };
        }
        incoming.set(id, { tabId: tab.id, from, timer: setTimeout(() => cancel(id), TRANSFER_TIMEOUT + 1000) });
        transferReadiness.set(id, (paneId, ok) => {
          if (!incoming.has(id) || !awaiting.delete(paneId)) return;
          if (!ok) {
            cancel(id);
            void reply(false).catch(reportError);
          } else if (awaiting.size === 0) void reply(true).catch(reportError);
        });
        replace(dispatch, next, "pane");
        if (awaiting.size === 0) await reply(true);
      } catch (error) {
        cancel(id);
        await reply(false);
        reportError(error);
      }
    };
    void receive().catch(reportError);
  });
  return () => {
    stop();
    for (const id of incoming.keys()) cancel(id);
  };
}
