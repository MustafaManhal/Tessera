import type { AutomationsClient } from "./client";
import type { Automation, AutomationFired, AutomationInput, AutomationRun, Trigger } from "./types";

/** In-memory automations client for the browser and the UI tests (`window.__tesseraAutomations`). */
export class FakeAutomationsClient implements AutomationsClient {
  private rows: Automation[] = [];
  private history = new Map<string, AutomationRun[]>();
  private changed = new Set<() => void>();
  private fired = new Set<(fired: AutomationFired) => void>();
  private counter = 0;
  now = () => Math.floor(Date.now() / 1000);

  private validate(input: AutomationInput): void {
    if (input.name.trim() === "") throw new Error("Give the automation a name.");
    if (input.prompt.trim() === "") throw new Error("Write the prompt the agent should get.");
    const trigger = input.trigger;
    if (trigger.type === "cron" && trigger.expr.trim().split(/\s+/).length !== 5)
      throw new Error("Use five fields: minute, hour, day of month, month, day of week.");
    if (trigger.type === "label") {
      if (!/^[^/\s]+\/[^/\s]+$/.test(trigger.repo)) throw new Error("Write the repository as owner/name.");
      if (trigger.label.trim() === "") throw new Error("Write the label to watch.");
    }
  }
  private nextFor(trigger: Trigger, enabled: boolean): number | null {
    return trigger.type === "cron" && enabled ? this.now() + 3600 : null;
  }
  private emitChanged() {
    for (const listener of this.changed) listener();
  }

  async list(): Promise<Automation[]> {
    return this.rows.map((row) => ({ ...row, last_run: this.history.get(row.id)?.[0] ?? null }));
  }
  async save(input: AutomationInput): Promise<Automation> {
    this.validate(input);
    const existing = input.id ? this.rows.find((row) => row.id === input.id) : undefined;
    if (input.id && !existing) throw new Error("The automation could not be found.");
    const row: Automation = {
      id: existing?.id ?? `au_${++this.counter}`,
      project_id: input.project_id,
      name: input.name.trim(),
      profile_id: input.profile_id,
      prompt: input.prompt,
      trigger: input.trigger,
      is_enabled: input.is_enabled,
      next_run_at: this.nextFor(input.trigger, input.is_enabled),
      last_run: null,
    };
    this.rows = existing ? this.rows.map((r) => (r.id === row.id ? row : r)) : [...this.rows, row];
    this.emitChanged();
    return row;
  }
  async remove(id: string): Promise<void> {
    this.rows = this.rows.filter((row) => row.id !== id);
    this.history.delete(id);
    this.emitChanged();
  }
  async runs(id: string): Promise<AutomationRun[]> {
    return this.history.get(id) ?? [];
  }
  async runNow(id: string): Promise<AutomationRun> {
    const row = this.rows.find((r) => r.id === id);
    if (!row) throw new Error("The automation could not be found.");
    const run = this.addRun(id, "ok", "Started a task.", "tsk_auto");
    for (const listener of this.fired)
      listener({
        automation_id: id,
        automation_name: row.name,
        task_id: "tsk_auto",
        profile_id: row.profile_id,
        prompt: row.prompt,
      });
    return run;
  }
  /** Test helper: a past run, e.g. a missed one. */
  addRun(id: string, status: AutomationRun["status"], message: string, taskId: string | null = null): AutomationRun {
    const run: AutomationRun = {
      id: `run_${(this.history.get(id)?.length ?? 0) + 1}`,
      automation_id: id,
      task_id: taskId,
      status,
      message,
      at: this.now(),
    };
    this.history.set(id, [run, ...(this.history.get(id) ?? [])]);
    this.emitChanged();
    return run;
  }
  onChanged(listener: () => void) {
    this.changed.add(listener);
    return () => void this.changed.delete(listener);
  }
  onFired(listener: (fired: AutomationFired) => void) {
    this.fired.add(listener);
    return () => void this.fired.delete(listener);
  }
}
