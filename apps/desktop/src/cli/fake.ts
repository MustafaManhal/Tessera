// FakeCliClient: an in-memory install state for the browser dev server and tests. `?demo` starts uninstalled so the
// consent flow can be exercised; tests flip it through the helpers.
import type { CliClient } from "./client";
import type { CliInstall } from "./types";

export class FakeCliClient implements CliClient {
  private state: CliInstall;
  readonly calls: string[] = [];

  constructor(options: { installed?: boolean; onPath?: boolean; target?: string } = {}) {
    const target = options.target ?? "~/.local/bin";
    const installed = options.installed ?? false;
    this.state = {
      installed,
      path: installed ? `${target}/tessera` : null,
      target,
      needs_admin: false,
      on_path: options.onPath ?? false,
    };
  }

  async cliInstallStatus(): Promise<CliInstall> {
    this.calls.push("cliInstallStatus");
    return structuredClone(this.state);
  }

  async cliInstall(): Promise<CliInstall> {
    this.calls.push("cliInstall");
    this.state = { ...this.state, installed: true, path: `${this.state.target}/tessera`, on_path: true };
    return structuredClone(this.state);
  }

  async cliUninstall(): Promise<CliInstall> {
    this.calls.push("cliUninstall");
    this.state = { ...this.state, installed: false, path: null, on_path: false };
    return structuredClone(this.state);
  }

  /** Test helper: put the fake in an arbitrary state. */
  setState(patch: Partial<CliInstall>): void {
    this.state = { ...this.state, ...patch };
  }
}
