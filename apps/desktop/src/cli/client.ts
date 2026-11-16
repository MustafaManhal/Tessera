// CliClient: the `tessera` command-line tool install status and consent commands (M6.3), like AgentsClient.
// - FakeCliClient (fake.ts): in memory, for the browser dev server and tests.
// - TauriCliClient (tauri.ts): the generated bindings.
import type { CliInstall } from "./types";

export interface CliClient {
  /** Whether the CLI is installed, where, and whether its folder is on PATH. */
  cliInstallStatus(): Promise<CliInstall>;
  /** Installs the CLI. Only ever called from an explicit click. */
  cliInstall(): Promise<CliInstall>;
  /** Removes the CLI. */
  cliUninstall(): Promise<CliInstall>;
}
