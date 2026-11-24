// The app's SshClient: the real commands in the native app, the fake in the browser and tests.
import { isNativeRuntime } from "../native/runtime";
import type { SshClient } from "./client";
import { FakeSshClient } from "./fake";
import { TauriSshClient } from "./tauri";

declare global {
  interface Window {
    __tesseraSsh?: FakeSshClient;
  }
}

let current: SshClient | null = null;

export function sshClient(): SshClient {
  if (!current) current = createSshClient();
  return current;
}

export function setSshClient(client: SshClient | null): void {
  current = client;
}

function createSshClient(search: string = window.location.search): SshClient {
  if (isNativeRuntime() && new URLSearchParams(search).get("ssh") !== "fake") return new TauriSshClient();
  const fake = new FakeSshClient();
  if (import.meta.env.DEV) window.__tesseraSsh = fake;
  return fake;
}
