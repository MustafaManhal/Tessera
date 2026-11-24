// In-memory OnboardingClient for DEV/tests: seedable sources and canned previews.

import type { OnboardingClient } from "./client";
import type { ImportPreview, ImportSource, OnboardingState } from "./types";

export class FakeOnboardingClient implements OnboardingClient {
  sources: ImportSource[] = [
    { id: "ghostty", name: "Ghostty", path: "/home/u/.config/ghostty/config", available: true },
    { id: "iterm2", name: "iTerm2", path: null, available: false },
    { id: "windowsterminal", name: "Windows Terminal", path: null, available: false },
  ];
  previews = new Map<string, ImportPreview>();
  applied: string[] = [];
  done = true;
  calls: string[] = [];

  async importSources(): Promise<ImportSource[]> {
    this.calls.push("importSources");
    await Promise.resolve();
    return this.sources;
  }

  async importPreview(sourceId: string): Promise<ImportPreview> {
    this.calls.push(`importPreview:${sourceId}`);
    await Promise.resolve();
    const preview = this.previews.get(sourceId);
    if (!preview) {
      throw Object.assign(new Error(`no ${sourceId} configuration found on this machine`), {
        code: "import.unavailable",
      });
    }
    return preview;
  }

  async importApply(sourceId: string): Promise<ImportPreview> {
    this.calls.push(`importApply:${sourceId}`);
    await Promise.resolve();
    this.applied.push(sourceId);
    const preview = this.previews.get(sourceId);
    if (!preview) {
      throw Object.assign(new Error(`no ${sourceId} configuration found on this machine`), {
        code: "import.unavailable",
      });
    }
    return preview;
  }

  async onboardingState(): Promise<OnboardingState> {
    this.calls.push("onboardingState");
    await Promise.resolve();
    return { done: this.done };
  }

  async onboardingComplete(): Promise<void> {
    this.calls.push("onboardingComplete");
    this.done = true;
    await Promise.resolve();
  }

  async onboardingReset(): Promise<void> {
    this.calls.push("onboardingReset");
    this.done = false;
    await Promise.resolve();
  }
}
