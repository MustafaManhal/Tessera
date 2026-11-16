// Which SettingsClient the app uses: the real one when the Tauri IPC bridge exists, an in-memory fake in a plain
// browser (dev server). Provided through React context like the PTY client.
import { createContext, type ReactNode, useContext } from "react";
import schema from "../../../../packages/ipc/schema/config.schema.json";
import { FakeSettingsClient, hasIpcBridge, type SettingsClient, TauriSettingsClient } from "./client";
import type { JsonSchema } from "./schema";

export const configSchema = schema as unknown as JsonSchema;

declare global {
  interface Window {
    __tesseraSettings?: FakeSettingsClient;
  }
}

export function createSettingsClient(): SettingsClient {
  if (hasIpcBridge()) return new TauriSettingsClient();
  // One fake per page: non-React callers (the DND action) share the app's client.
  if (import.meta.env.DEV && typeof window !== "undefined" && window.__tesseraSettings) {
    return window.__tesseraSettings;
  }
  const fake = new FakeSettingsClient(configSchema);
  if (import.meta.env.DEV && typeof window !== "undefined") window.__tesseraSettings = fake;
  return fake;
}

const SettingsClientContext = createContext<SettingsClient | null>(null);

export function SettingsClientProvider({ client, children }: { client: SettingsClient; children: ReactNode }) {
  return <SettingsClientContext value={client}>{children}</SettingsClientContext>;
}

export function useSettingsClient(): SettingsClient {
  const client = useContext(SettingsClientContext);
  if (!client) throw new Error("useSettingsClient needs a <SettingsClientProvider>");
  return client;
}
