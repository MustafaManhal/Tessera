import { commands, unwrap } from "@tessera/ipc";
import type { OnboardingClient } from "./client";
import type { ImportPreview, ImportSource, OnboardingState } from "./types";

/** An `AppError` becomes an Error with the backend's sentence; its code stays on `.code`. */
async function call<T>(promise: Promise<{ status: "ok"; data: T } | { status: "error"; error: unknown }>): Promise<T> {
  try {
    return await unwrap(promise as never);
  } catch (cause) {
    const error = cause as { code?: string; message?: string };
    throw Object.assign(new Error(error?.message || String(cause)), { code: error?.code });
  }
}

export class TauriOnboardingClient implements OnboardingClient {
  async importSources() {
    // Non-Result command: the bindings return the array directly.
    return (await commands.importSources()) as ImportSource[];
  }
  importPreview(sourceId: string) {
    return call(commands.importPreview(sourceId)) as Promise<ImportPreview>;
  }
  importApply(sourceId: string) {
    return call(commands.importApply(sourceId)) as Promise<ImportPreview>;
  }
  onboardingState() {
    return call(commands.onboardingState()) as Promise<OnboardingState>;
  }
  async onboardingComplete() {
    await call(commands.onboardingComplete());
  }
  async onboardingReset() {
    await call(commands.onboardingReset());
  }
}
