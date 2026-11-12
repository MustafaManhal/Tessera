// Token and cost figures for a task (M9.6, FR-44). Mirrors the Rust `TaskUsage` DTO.
export interface TaskUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  /** An estimate from a bundled price table; null when a model used has no price. */
  cost_usd: number | null;
  models: string[];
  agents: string[];
}
