// Tokens and estimated cost of a task, read from the agent CLIs' own session logs (M9.6, FR-44). Refreshed when the
// agent's status changes and every 30 s while the window is visible. Shows nothing when the agent does not report usage.
import { t, Tooltip } from "@tessera/ui";
import { useEffect, useState } from "react";
import { formatCost, formatTokens } from "./format";
import { usageClient } from "./service";
import type { TaskUsage } from "./types";

const REFRESH_MS = 30_000;

export function useTaskUsage(taskId: string | null, refreshKey: unknown): TaskUsage | null {
  const [usage, setUsage] = useState<TaskUsage | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshKey only re-runs the load (the agent's status changed).
  useEffect(() => {
    if (!taskId) return;
    let alive = true;
    const load = () => {
      if (document.visibilityState === "hidden") return;
      usageClient()
        .taskUsage(taskId)
        .then((next) => {
          if (alive) setUsage(next);
        })
        .catch(() => {});
    };
    load();
    const timer = setInterval(load, REFRESH_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [taskId, refreshKey]);
  return usage;
}

export function UsageChip({ taskId, refreshKey }: { taskId: string | null; refreshKey?: unknown }) {
  const usage = useTaskUsage(taskId, refreshKey);
  if (!usage) return null;
  const total = usage.input_tokens + usage.output_tokens + usage.cache_read_tokens + usage.cache_write_tokens;
  const detail = t("usage.detail", {
    input: formatTokens(usage.input_tokens),
    output: formatTokens(usage.output_tokens),
    cached: formatTokens(usage.cache_read_tokens + usage.cache_write_tokens),
  });
  const note = usage.cost_usd === null ? t("usage.noPrice") : t("usage.estimated");
  return (
    <Tooltip label={`${detail} · ${note}`}>
      <button
        type="button"
        data-usage-chip
        className="inline-flex items-center gap-1 rounded-sm bg-surface-3 px-1 text-xs text-muted"
      >
        <span data-usage-tokens>{t("usage.tokens", { count: formatTokens(total) })}</span>
        {usage.cost_usd !== null && <span data-usage-cost>{`~${formatCost(usage.cost_usd)}`}</span>}
      </button>
    </Tooltip>
  );
}
