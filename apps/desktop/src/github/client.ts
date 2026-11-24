// GitHub connection client (FR-54): tauri bindings in the app, an in-memory fake for tests.
import { commands } from "@tessera/ipc";
import { unwrap } from "@tessera/ipc";

export interface GithubConnectStart {
  userCode: string;
  verificationUri: string;
  deviceCode: string;
  interval: number;
}

export interface GithubIntegration {
  login: string;
  id: number;
  scopes: string;
  connectedAt: number;
}

export interface GithubClient {
  connectStart(): Promise<GithubConnectStart>;
  /** null while pending; resolves with the integration once connected. */
  connectPoll(deviceCode: string): Promise<GithubIntegration | null>;
  importGh(): Promise<GithubIntegration>;
  status(): Promise<GithubIntegration | null>;
  disconnect(): Promise<void>;
}

export class TauriGithubClient implements GithubClient {
  connectStart() {
    return unwrap(commands.githubConnectStart());
  }
  connectPoll(deviceCode: string) {
    return unwrap(commands.githubConnectPoll(deviceCode));
  }
  importGh() {
    return unwrap(commands.githubImportGh());
  }
  status() {
    return unwrap(commands.githubStatus());
  }
  async disconnect() {
    await unwrap(commands.githubDisconnect());
  }
}

export class FakeGithubClient implements GithubClient {
  integration: GithubIntegration | null = null;
  failImport: string | null = null;
  private pending = 0;

  async connectStart(): Promise<GithubConnectStart> {
    return {
      userCode: "WDJB-MJHT",
      verificationUri: "https://github.com/login/device",
      deviceCode: "fake-device",
      interval: 1,
    };
  }
  async connectPoll(_deviceCode: string): Promise<GithubIntegration | null> {
    if (this.pending > 0) {
      this.pending -= 1;
      return null;
    }
    return this.status();
  }
  async importGh(): Promise<GithubIntegration> {
    if (this.failImport) throw new Error(this.failImport);
    this.integration = { login: "octocat", id: 1, scopes: "repo read:org", connectedAt: 1700000000 };
    return this.integration;
  }
  /** Simulate finishing the device flow after `pending` polls. */
  finishDeviceFlow() {
    this.pending = 1;
    this.integration = { login: "hubot", id: 2, scopes: "repo read:org", connectedAt: 1700000001 };
  }
  async status() {
    return this.integration;
  }
  async disconnect() {
    this.integration = null;
  }
}

declare global {
  interface Window {
    __tesseraGithub?: FakeGithubClient;
  }
}

let current: GithubClient | null = null;
export function setGithubClient(client: GithubClient | null) {
  current = client;
}
export function githubClient(): GithubClient {
  if (!current) {
    if (import.meta.env.DEV) {
      const fake = new FakeGithubClient();
      window.__tesseraGithub = fake;
      current = fake;
    } else {
      current = new TauriGithubClient();
    }
  }
  return current;
}
