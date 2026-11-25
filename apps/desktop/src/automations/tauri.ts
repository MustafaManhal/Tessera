import { commands, events, unwrap } from "@tessera/ipc";
import type { AutomationsClient } from "./client";
import type { Automation, AutomationInput, AutomationRun } from "./types";

/** An `AppError` becomes an Error carrying the backend's sentence. */
async function call<T>(promise: Promise<{ status: "ok"; data: T } | { status: "error"; error: unknown }>): Promise<T> {
  try {
    return await unwrap(promise as never);
  } catch (cause) {
    const error = cause as { message?: string };
    throw new Error(error?.message || String(cause));
  }
}

export class TauriAutomationsClient implements AutomationsClient {
  list() {
    return call(commands.automationsList()) as Promise<Automation[]>;
  }
  save(input: AutomationInput) {
    return call(commands.automationSave(input)) as Promise<Automation>;
  }
  async remove(id: string) {
    await call(commands.automationDelete(id));
  }
  runs(id: string) {
    return call(commands.automationRuns(id)) as Promise<AutomationRun[]>;
  }
  runNow(id: string) {
    return call(commands.automationRunNow(id)) as Promise<AutomationRun>;
  }
  onChanged(listener: () => void) {
    const pending = events.automationChanged.listen(() => listener());
    return () => void pending.then((stop) => stop());
  }
  onFired(listener: Parameters<AutomationsClient["onFired"]>[0]) {
    const pending = events.automationFired.listen((event) => listener(event.payload));
    return () => void pending.then((stop) => stop());
  }
}
