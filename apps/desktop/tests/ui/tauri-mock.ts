import type { Page } from "@playwright/test";

/** Canned replies for IPC commands, keyed by command name. */
export type IpcReplies = Record<string, unknown>;

/**
 * Installs a fake Tauri IPC bridge before any app script runs. It mirrors what `mockIPC` and `mockWindows("main")`
 * from `@tauri-apps/api/mocks` set up (`window.__TAURI_INTERNALS__`), but as a self-contained init script, because
 * Playwright init scripts cannot import modules. Every call is recorded in `window.__TESSERA_IPC_CALLS__`.
 */
export async function mockTauri(page: Page, replies: IpcReplies = {}): Promise<void> {
  await page.addInitScript((canned: IpcReplies) => {
    type Callback = (data: unknown) => void;
    const w = window as unknown as Record<string, unknown>;
    const calls: Array<{ cmd: string; args: unknown }> = [];
    const listeners: Record<string, number[]> = {};
    const callbacks = new Map<number, Callback>();
    let nextId = 1;
    w.__TESSERA_IPC_CALLS__ = calls;
    w.__TAURI_INTERNALS__ = {
      metadata: {
        currentWindow: { label: "main" },
        currentWebview: { windowLabel: "main", label: "main" },
      },
      invoke: async (cmd: string, args: unknown) => {
        calls.push({ cmd, args });
        // Events: `listen` registers the callback; tests fire it with `window.__tesseraEmit(event, payload)`.
        if (cmd === "plugin:event|listen") {
          const { event, handler } = args as { event: string; handler: number };
          listeners[event] = [...(listeners[event] ?? []), handler];
          return handler;
        }
        if (cmd === "plugin:event|unlisten") return null;
        // A test can answer commands itself: `page.exposeFunction("__tesseraIpc", (cmd, args) => ...)` returns
        // `{ ok: value }` or `{ err: {code, message} }` (an AppError, which the generated bindings turn into
        // an error result), or nothing to fall through to the canned replies.
        const handler = w.__tesseraIpc as ((c: string, a: unknown) => Promise<unknown>) | undefined;
        if (typeof handler === "function") {
          const answer = (await handler(cmd, args)) as { ok?: unknown; err?: unknown } | null | undefined;
          if (answer && "err" in answer) throw answer.err;
          if (answer && "ok" in answer) return answer.ok;
        }
        if (cmd in canned) return canned[cmd];
        throw new Error(`mockTauri: no reply for IPC command "${cmd}"`);
      },
      transformCallback: (callback: Callback, once = false) => {
        const id = nextId++;
        callbacks.set(id, (data) => {
          if (once) callbacks.delete(id);
          callback(data);
        });
        return id;
      },
      unregisterCallback: (id: number) => callbacks.delete(id),
      runCallback: (id: number, data: unknown) => callbacks.get(id)?.(data),
      callbacks,
      convertFileSrc: (path: string) => path,
    };
    w.__tesseraEmit = (event: string, payload: unknown) => {
      for (const id of listeners[event] ?? []) callbacks.get(id)?.({ event, id, payload });
    };
    w.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: (_event: string, id: number) => callbacks.delete(id) };
  }, replies);
}
