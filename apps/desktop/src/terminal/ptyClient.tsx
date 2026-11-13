// Which PtyClient the app uses, and the React context that hands it to terminal panes.
// - In the Tauri app: `TauriPtyClient`, once `PTY_HOST_READY` is true (the lead flips it when brief 05's `pty_*`
//   commands land); until then the panes show the placeholder.
// - In a plain browser (dev server, Playwright): `FakePtyClient`, exposed as `window.__tesseraFakePty` for tests.
// - `?placeholder` in the URL forces the placeholder anywhere.
import { isTauri } from "@tauri-apps/api/core";
import { FakePtyClient, type PtyClient, WebSocketPtyClient } from "@tessera/term";
import { createContext, type ReactNode, useContext } from "react";
import { TauriPtyClient } from "./TauriPtyClient";

/** Set to true when `pty_spawn`/`pty_write`/`pty_resize`/`pty_ack`/`pty_kill` exist in the Rust app (brief 05). */
export const PTY_HOST_READY = true;

declare global {
  interface Window {
    __tesseraFakePty?: FakePtyClient;
  }
}

export function createPtyClient(search: string = window.location.search): PtyClient | null {
  if (new URLSearchParams(search).has("placeholder")) return null;
  if (isTauri()) return PTY_HOST_READY ? new TauriPtyClient() : null;
  if (import.meta.env.DEV) {
    const params = new URLSearchParams(search);
    const bridge = params.get("pty");
    const token = params.get("token");
    if (bridge || token) {
      if (!bridge || !token) throw new Error("The PTY bridge URL and token must both be provided");
      return new WebSocketPtyClient(bridge, token, undefined, params.get("shell") ?? undefined);
    }
  }
  const fake = new FakePtyClient();
  window.__tesseraFakePty = fake;
  return fake;
}

const PtyClientContext = createContext<PtyClient | null>(null);

export function PtyClientProvider({ client, children }: { client: PtyClient | null; children: ReactNode }) {
  return <PtyClientContext value={client}>{children}</PtyClientContext>;
}

/** The PtyClient for this app, or null when panes show the placeholder. */
export function usePtyClient(): PtyClient | null {
  return useContext(PtyClientContext);
}
