import type { Renderer } from "@tessera/term";

export interface TerminalLatencySummary {
  n: number;
  p50: number;
  p95: number;
  p99: number;
  renderer: Renderer;
  samples: number[];
}

declare global {
  interface Window {
    __tessera_latency?: TerminalLatencySummary;
  }
}

export function summarizeLatency(samples: number[], renderer: Renderer): TerminalLatencySummary {
  const sorted = [...samples].sort((a, b) => a - b);
  const percentile = (fraction: number) => sorted[Math.max(0, Math.ceil(fraction * sorted.length) - 1)] ?? 0;
  return {
    n: sorted.length,
    p50: percentile(0.5),
    p95: percentile(0.95),
    p99: percentile(0.99),
    renderer,
    samples: [...samples],
  };
}
