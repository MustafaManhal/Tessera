import { isTauri } from "@tauri-apps/api/core";
import { FakeOnboardingClient } from "./fake";
import { TauriOnboardingClient } from "./tauri";
import type { ImportPreview, ImportSource, OnboardingState } from "./types";

export interface OnboardingClient {
  /** Detected terminal configs on this machine; `available` gates the import buttons. */
  importSources(): Promise<ImportSource[]>;
  /** Parses a detected config: what would apply plus per-item misses. Reads only. */
  importPreview(sourceId: string): Promise<ImportPreview>;
  /** Applies the importable items through the config patch path and returns the same preview. */
  importApply(sourceId: string): Promise<ImportPreview>;
  onboardingState(): Promise<OnboardingState>;
  onboardingComplete(): Promise<void>;
  /** Settings → General → "Run setup again". */
  onboardingReset(): Promise<void>;
}

// -- Singleton -------------------------------------------------------------------------------------------------

declare global {
  interface Window {
    __tesseraOnboarding?: OnboardingClient;
  }
}

let client: OnboardingClient | null = null;

// DEV/tests: expose the fake eagerly so specs can seed it before the first onboarding() call.
if (import.meta.env.DEV && !isTauri() && typeof window !== "undefined" && !window.__tesseraOnboarding) {
  window.__tesseraOnboarding = new FakeOnboardingClient();
}

export function onboarding(): OnboardingClient {
  if (!client) {
    client =
      import.meta.env.DEV && !isTauri()
        ? ((window.__tesseraOnboarding as FakeOnboardingClient) ?? new FakeOnboardingClient())
        : new TauriOnboardingClient();
    if (import.meta.env.DEV && typeof window !== "undefined") window.__tesseraOnboarding = client;
  }
  return client;
}
