// Cold-start timeline marks (NFR-03). Only a benchmark launch (`TESSERA_BENCH_ROOT`) sets `window.__TESSERA_BENCH__`;
// everywhere else this does nothing, so it costs one property read.
declare global {
  interface Window {
    __TESSERA_BENCH__?: boolean;
  }
}

export function benchMark(name: string): void {
  if (!window.__TESSERA_BENCH__) return;
  const internals = (
    window as unknown as { __TAURI_INTERNALS__?: { invoke(cmd: string, args: unknown): Promise<unknown> } }
  ).__TAURI_INTERNALS__;
  void internals?.invoke("benchmark_mark", { name }).catch(() => {});
}
