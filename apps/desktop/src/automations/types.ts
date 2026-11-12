// Automations (M9.5, FR-61). Mirrors the Rust DTOs.
export type Trigger = { type: "cron"; expr: string } | { type: "label"; repo: string; label: string };

export interface AutomationRun {
  id: string;
  automation_id: string;
  task_id: string | null;
  status: "ok" | "failed" | "missed";
  message: string;
  /** Unix seconds. */
  at: number;
}

export interface Automation {
  id: string;
  project_id: string;
  name: string;
  profile_id: string;
  prompt: string;
  trigger: Trigger;
  is_enabled: boolean;
  /** Unix seconds; null for label triggers and disabled automations. */
  next_run_at: number | null;
  last_run: AutomationRun | null;
}

export interface AutomationInput {
  id: string | null;
  project_id: string;
  name: string;
  profile_id: string;
  prompt: string;
  trigger: Trigger;
  is_enabled: boolean;
}

/** A run created a task: the agent starts in it. */
export interface AutomationFired {
  automation_id: string;
  automation_name: string;
  task_id: string;
  profile_id: string;
  prompt: string;
}
