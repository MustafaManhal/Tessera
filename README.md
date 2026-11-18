# Tessera

A fast terminal for macOS and Windows that runs a fleet of coding agents. Every agent (Claude Code, Codex,
Gemini CLI, OpenCode and others) works in its own git worktree, in a real terminal pane, and the sidebar shows which
one is working, which one needs you, and what each one changed. Tessera is a working name.

Status: early development. Tessera is a working name.

## Stack
Tauri 2 (Rust core) + React 19 / TypeScript + xterm.js (WebGL). pnpm workspaces and a Cargo workspace.

## How to run
Prerequisites: Rust stable (via [rustup](https://rustup.rs)), Node 22, pnpm (version pinned in `package.json`, `corepack enable pnpm`), and the
[Tauri prerequisites](https://tauri.app/start/prerequisites/) for your OS (Xcode Command Line Tools on macOS;
Microsoft C++ Build Tools and WebView2 on Windows).

```sh
pnpm install
pnpm dev                 # opens the app (dev server on port 1420)
TESSERA_DEV_PORT=1421 pnpm dev   # macOS/Linux: a second checkout on another port
pnpm check               # the quick checks that must pass before every commit
```

PowerShell port override: `$env:TESSERA_DEV_PORT="1421"; pnpm dev`.

For mocked UI screenshots, start `pnpm --filter @tessera/desktop exec vite --port 1421`, then run
`node scripts/shot.mjs --url "http://localhost:1421/?gallery" --name gallery --out /tmp/tessera-shots` in another terminal.
Chromium must already be installed for Playwright (`pnpm exec playwright install chromium`).

## Checks
`pnpm check` must pass before every commit. It runs these steps in order and stops at the first failure, naming the
step (`pnpm check --from <step>` resumes from one):

| Step | Command | What |
| --- | --- | --- |
| `format:check` | `biome format .` | Formatting (2 spaces, width 120, double quotes, semicolons) |
| `lint` | `biome lint .` | Biome recommended rules |
| `typecheck` | `pnpm -r --if-present typecheck` | Strict TypeScript in every package |
| `test` | `vitest run` | Unit tests (Vitest projects: `apps/desktop`, `packages/*`) |
| `rust:fmt` | `cargo fmt --all --check` | rustfmt (`rustfmt.toml`) |
| `rust:clippy` | `cargo clippy --workspace --all-targets -- -D warnings` | Clippy; any warning fails |
| `rust:test` | `cargo test --workspace` | Rust unit tests |

`pnpm format` fixes formatting. `pnpm test:ui` runs the Playwright UI tests: the React app in Chromium with the
Tauri IPC mocked (`apps/desktop/tests/ui/`); set `TESSERA_DEV_PORT` to use this checkout's port. CI
(`.github/workflows/ci.yml`) runs `pnpm check` and a debug build on Ubuntu and Windows, and the UI tests on Ubuntu;
the macOS build runs only on manual dispatch and `v*` tags.

## Project layout
| Folder | What |
| --- | --- |
| `apps/desktop` | The Tauri app: React UI in `src/`, Rust shell in `src-tauri/` |
| `packages/term`, `packages/ui`, `packages/ipc` | Terminal adapter, design tokens and components, generated IPC types |
| `crates/*` | Rust core: PTY, shell, git, agents, forge, store, API, CLI, daemon, sync |
| `scripts/`, `fixtures/`, `docs/` | Dev scripts, test fixtures, user docs |

## License
MIT
