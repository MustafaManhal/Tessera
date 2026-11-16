# Performance

Targets come from the product requirements (NFR-01 to NFR-06 and NFR-13). The numbers below were measured on an
Apple M2 Pro (macOS 27.2) with a release build (`pnpm --filter @tessera/desktop tauri build --no-bundle`) on
2026-11-12. Windows numbers come from the benchmark workflow (`win-5-benchmarks.yml`) and are recorded in the
planning notes; the scenarios below run unchanged there.

| Target | Requirement | Measured on macOS | How |
| --- | --- | --- | --- |
| NFR-01 input latency | p95 ≤ 16 ms | host round trip p95 0.03 ms; with 50 sessions and 20 busy agents p95 0.2 to 0.4 ms | `pnpm bench:latency` (host), `tests/ui/latency.spec.ts` (key to glyph, both renderers) |
| NFR-02 throughput | 100 MB in ≤ 5 s | 100 MiB in 0.79 s (126 MiB/s) | `pnpm bench:throughput` |
| NFR-03 cold start (our share) | ≤ 600 ms | median 554 to 557 ms over repeated runs (was 593 to 598 before the bundle work below). p95 is 2.2 s on the first run after install (login environment probe, cached afterwards) | `pnpm bench:cold-start` |
| NFR-04 memory | ≤ 150 MB with 4 panes, ≤ 25 MB per extra pane | 64 MB footprint with 4 panes, 4.5 MB per extra pane (RSS 159 MB, see D-17) | `pnpm bench:memory` |
| NFR-06 agent status | ≤ 1 s from hook to sidebar | well under a millisecond for the backend hop (gate in `agent_status.rs`); the sidebar renders on the next frame | `cargo test -p tessera-desktop agent_status` |
| NFR-13 scale | 50 panes and 20 agents without breaking NFR-01 | 50 real terminals ready in 6.4 s, 271 MB footprint (4.6 MB per pane), 0 % idle CPU; focused-pane latency p95 0.2 ms with 20 busy agents | `pnpm bench:scale`, `pnpm bench:latency` |

## Windows (release build on a GitHub `windows-latest` runner, no GPU; Windows 5, run 43213861852)

Memory is the private working set of Tessera's processes (app, session daemon, WebView2), without the shells in the panes
(D-18, D-19).

| Target | Requirement | Measured | State |
| --- | --- | --- | --- |
| NFR-01 | p95 ≤ 40 ms gate on Windows (D-15, ConPTY paces output in ~16 ms frames) | host p95 about 22 ms; about 17 ms with 50 sessions and 20 busy agents | met |
| NFR-02 | 100 MB in ≤ 40 s on Windows (D-16) | 8.5 MiB/s, about 12 s | met |
| NFR-03 | ≤ 1000 ms our share | 800 ms in one run, 1170 ms in the next on the same runner: shared runners vary by 50 % between runs | not stable on CI; needs a real machine |
| NFR-04 | ≤ 150 MB with 4 panes, ≤ 25 MB per extra pane | 164 MB with one pane, 207 MB with four; 14 MB per extra pane | per pane met; the absolute 150 MB is **not reachable**: the WebView2 runtime alone is about 160 MB private |
| NFR-13 | 50 panes | all 50 prompts in 24 s, 346 MB total (3.4 MB per pane), 0 % idle CPU | met on memory and CPU |

The 150 MB figure was set before the Windows webview was measured. Either NFR-04 is restated for Windows (for example
250 MB with four panes), or Tessera stops using WebView2, which is not on the table. This is the owner's decision.
Cold start on Windows still needs a run on a real machine, because the CI runner's own variance is larger than the target's margin.

## Re-running

1. Build the release binary: `pnpm --filter @tessera/desktop tauri build --no-bundle`.
2. `pnpm bench:cold-start`, `pnpm bench:latency`, `pnpm bench:throughput`, `pnpm bench:memory`, `pnpm bench:scale`.
   Each run appends its result with the machine and commit to `.ai/research/bench.md` (or `docs/benchmarks.md` in the
   public repo). `TESSERA_BENCH_PANES` changes the pane count of the scale scenario.
3. The benchmark windows open on screen for a few seconds; they use a disposable data folder and are closed by the
   script.

## What the harness does not measure

- The webview's own content process (DOM and JavaScript heap) is not in the memory numbers on macOS: WebKit services
  are reparented and cannot be attributed to the app by `ps`.
- Key to glyph through the real window server needs a person at the keyboard; the UI test measures it in the browser
  with the real renderer and a fake PTY, and the host numbers cover the PTY side.

## Findings of the pass

- A release build was broken by debug-only smoke harnesses that were called without their `cfg(debug_assertions)`
  gate. Fixed, and `pnpm check` now lints the release build (`rust:release`) so it cannot happen unnoticed again.
- RSS grew from 134 MB to 158 MB at 4 panes since M1 because the binary and its dependencies grew; the footprint is the
  honest measure (D-17).
- The release profile builds dependencies for size (`opt-level = "s"` for `package."*"`, our own crates stay at 3): the
  macOS universal installer was 25.8 MB, over NFR-05, and is now about 23 MB. Throughput and latency did not change
  (throughput went from 112 to 126 MiB/s run to run noise); the Windows installers are 9 to 13 MB.
- The start bundle went from 2.8 MB to 1.4 MB, and cold start from 595 to 555 ms. Two causes: the diff engine
  (CodeMirror) now loads when the review panel or compare view first opens (0.57 MB), and a lookup of an icon by name
  in the whole `Icons` namespace (`Icons[name]`, in the inbox) had pulled all 2000 lucide icons into the bundle;
  icons are now referenced statically (85 in the bundle). Do not index the `Icons` namespace by a string.
- `pnpm bench:cold-start` measures the in-process shell path (the marks come from the PTY host). When `tesserad` sits
  next to the binary the app uses the session daemon and those marks do not exist: run it as
  `TESSERA_SESSION_DAEMON=0 pnpm bench:cold-start` (the script now sets this itself).
