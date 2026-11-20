import type { Automation, AutomationFired, AutomationInput, AutomationRun } from "./types";

export type Unsubscribe = () => void;

export interface AutomationsClient {
  list(): Promise<Automation[]>;
  save(input: AutomationInput): Promise<Automation>;
  remove(id: string): Promise<void>;
  runs(id: string): Promise<AutomationRun[]>;
  runNow(id: string): Promise<AutomationRun>;
  onChanged(listener: () => void): Unsubscribe;
  onFired(listener: (fired: AutomationFired) => void): Unsubscribe;
}
