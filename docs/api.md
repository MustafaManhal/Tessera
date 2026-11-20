# Tessera local API and CLI

The running Tessera app exposes a local JSON-RPC 2.0 API and ships a `tessera` CLI that talks to it. Both are
meant for automation: scripts, CI jobs and other tools can create tasks, launch agents, wait for them and read
their output without driving the UI.

## Transport

- Newline-delimited JSON-RPC 2.0. One request (or one batch array) per connection; the server answers with one
  response line and closes.
- macOS: Unix socket at `~/Library/Application Support/Tessera/tessera.sock` (or `Tessera Dev/tessera.sock` for
  the dev build). Windows: named pipe `\\.\pipe\tessera-<hash>` derived from the data folder.
- Maximum request and response line: 1 MiB.
- API version: `1` (sent as `"api_version": 1` in every request).

### Endpoint overrides (mainly for tests)

| Variable | Effect |
| --- | --- |
| `TESSERA_SOCKET` | Socket path (Unix) or pipe name (Windows) instead of the default. |
| `TESSERA_API_TOKEN_FILE` | Token file location instead of `<data dir>/api-token`. |
| `--dev` CLI flag | Use the `Tessera Dev` data folder. |

## Authentication

Every request must carry `"auth": "<token>"`. The token is 256 bits of randomness, written once at
`<data dir>/api-token` (mode 0600 on Unix; user-only ACL on Windows). The CLI reads it automatically; panes get
`TESSERA_SOCKET` and `TESSERA_API_TOKEN_FILE` in their environment so agent hooks can call `hook.event`.

A wrong or missing token fails with JSON-RPC error `-32001 Unauthorized`.

### Request shape

```json
{"jsonrpc":"2.0","api_version":1,"id":1,"auth":"<token>","method":"task.list","params":{"status":"active"}}
```

Success: `{"jsonrpc":"2.0","id":1,"result":<value>}`. Failure: `{"jsonrpc":"2.0","id":1,"error":{"code":…,"message":"…"}}`.

## Errors

| Code | Meaning |
| --- | --- |
| `-32600` | Invalid request / oversized line |
| `-32601` | Method not found |
| `-32602` | Invalid params |
| `-32603` | Internal error |
| `-32700` | Parse error |
| `-32001` | Unauthorized (bad or missing token) |
| `-32002` | NotFound (unknown task, project, session, …) |
| `-32003` | InvalidState (the operation cannot run in the current state; the message carries details) |

The CLI exits `0` on success, `2` on any API or usage error, and `3` specifically when `agent wait` times out.

## Methods

### `app.info`

No params. Result: `{"version": "<app version>", "api_version": 1}`.

```sh
tessera info                 # human-readable
tessera info --json          # {"version":"…","api_version":1}
```

### `project.list`

No params. Result: `Project[]` sorted by configured order. Fields include `id`, `name`, `path`, `default_branch`,
`remote_url`, `setup_state` and more (the same wire model the UI uses).

```sh
tessera project ls           # name⇥path⇥id per line
tessera project ls --json    # raw array
```

### `project.add`

Params: `{"path": "<folder>"}` — a local git repository (or a folder that can be `git init`ed is rejected; clone
URLs are a UI feature, not API). Result: the created `Project`.

```sh
tessera project add ~/code/myrepo
```

### `task.list`

Params: `{"project"?: "<id|slug|path>", "status"?: "<state>"}` — both optional. `status` matches the task state
(`backlog`, `setting_up`, `active`, `archived`, `error`). Result: `TaskSummary[]` (task fields flattened plus
`ahead`/`behind`/`changed_files` git facts and `ports`).

```sh
tessera task ls
tessera task ls --project myrepo --status active --json
```

### `task.create`

Params: `{"project": "<id|path>", "prompt"?: string, "agents"?: ["<agent id>", …], "base"?: "<branch>", "name"?: string}`.
Creates the task (worktree on `tessera/<slug>` unless the project uses the main checkout) and, for every entry in
`agents`, resolves the agent's default profile, builds the launch plan, spawns the agent in a headless PTY inside
the task's checkout and delivers `prompt` the same way the UI does (stdin, or typed after the ready pattern).
Agent CLIs get `TESSERA_SESSION_ID`/`TESSERA_TASK_ID`/`TESSERA_AGENT_SESSION_ID`, so their hooks report status.

Result: `{"tasks": [TaskSummary], "agents": [{id, task_id, agent_id, profile_id, status, pane_session_id} | {agent, error}]}`.
An agent that fails to launch (for example not installed) appears in `agents` with an `error` field; the task is
still created.

```sh
tessera task new --project myrepo --agent claude --agent codex "fix the login bug"
tessera task new "quick experiment" --json
```

### `task.archive` / `task.delete`

Params: `{"task": "<id|slug|name>", "confirm_lost_commits"?: bool}`. `archive` keeps files and releases ports;
`delete` removes the owned worktree and branch after data-loss checks — unmerged commits or a dirty worktree fail
with `InvalidState` unless `confirm_lost_commits` is true. Result: `null`.

```sh
tessera task archive my-task
tessera task rm my-task --confirm
```

### `agent.status`

Params: `{"task": "<id|slug|name>"}`. Result: the newest agent session of the task:
`{"status", "since" (epoch ms of the last transition), "message"?, "session" (agent session id), "agent"}`.
`status` is one of `starting`, `working`, `needs_input`, `idle`, `error`, `exited`.

```sh
tessera agent status my-task
```

### `agent.wait`

Params: `{"task": "…", "statuses": ["idle", "needs_input", …], "timeout_ms"?: number}` (default 300 000, max
24 h). Blocks until the newest session's status is one of `statuses`. Result:
`{"status": "<last seen>", "timed_out": bool}`.

CLI: `tessera agent wait <task> --status idle --status needs_input [--timeout <seconds>]`.
Exit code `0` when a wanted status was reached, `3` on timeout, `2` on error.

```sh
tessera agent wait my-task --status idle --status needs_input --timeout 900
```

### `agent.send`

Params: `{"task": "…", "text": "…"}`. Writes the text to the newest agent pane of the task followed by Enter
(submit). Result: `null`. Fails with `InvalidState` when the agent has no running pane.

```sh
tessera agent send my-task "also update the tests"
```

### `pane.read`

Params: exactly one of `{"task": "…"}` or `{"session": "<pty session id | agent session id>"}`, plus
`"lines"?: number` (default 200, max 5000). Result: `{"text": "<last N lines>"}` — ANSI escapes stripped, from the
session's scrollback ring.

```sh
tessera pane read my-task --lines 200
tessera pane read whatever --session <session-id> --lines 50
```

### `review.diff`

Params: `{"task": "…"}`. Result: `{"patch": "<unified diff>"}` of the task's checkout against the merge base with
its base branch — committed, staged, unstaged and untracked changes included (untracked files are added with
`git add -N` for the diff and the index is restored afterwards). Works for `ssh://` worktrees through the same git
runner the review panel uses. The patch is capped at ~768 KiB.

```sh
tessera review diff my-task > change.patch
```

### `hook.event`

Params: `{"tessera_session_id", "agent", "event", "payload", "at"}` — the shape agent hook integrations send
(see the agents documentation). Appends the vendor payload and feeds the status engine. Result: `null`.

```sh
echo '{"question":"Allow?"}' | tessera hook Notification --payload -
# or rely on TESSERA_SESSION_ID inside an agent pane:
tessera hook Stop < payload.json
```

### `app.notify`

Params: `{"title": "…", "body": "…"}`. Shows an OS notification through the app. Result: `null`.

```sh
tessera notify "Build done" "tessera task new finished"
```

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Success (`agent wait` also uses it when a wanted status was reached). |
| `2` | Any error: API unreachable, auth failure, bad params, unknown task, server-side failure, clap usage error. |
| `3` | `agent wait` only: the timeout expired before a wanted status appeared. |

`--json` (global flag) prints the raw JSON-RPC `result` on every command; without it, commands print a short
human-readable summary (`pane read` and `review diff` always print their payload).

## Scripting a best-of-3

```sh
#!/bin/sh
# Run three agents on the same prompt, wait for all of them, keep the first to finish cleanly.
set -eu
TASKS=""
for agent in claude codex gemini; do
  id=$(tessera task new --project myrepo --agent "$agent" --json "fix the login bug" \
        | python3 -c 'import json,sys; print(json.load(sys.stdin)["tasks"][0]["id"])')
  TASKS="$TASKS $id"
done
for id in $TASKS; do
  # Wait until the agent is idle or needs input (or exited with an error).
  tessera agent wait "$id" --status idle --status needs_input --status exited --timeout 1800 || true
done
for id in $TASKS; do
  echo "=== $id ==="
  tessera agent status "$id"
  tessera review diff "$id" | head -40
done
# Inspect, pick a winner in the UI (or automate further with task.archive/task.rm), e.g.:
# tessera task archive <loser-1> && tessera task archive <loser-2>
```

Notes for scripts:

- `task.create` returns as soon as the agents are spawned; use `agent.wait`/`agent.status` to follow them.
- `agent.send` submits with Enter; for raw keystrokes use `pane.read`-style flows through the UI.
- All commands accept task ids, slugs or unique names, and project ids, slugs or paths.

## MCP server

Enable **Settings → Advanced → API → Let agents drive Tessera through MCP** (off by default). Keep Tessera
running with the local API socket enabled. Run `tessera mcp` as a stdio MCP server; it writes only newline-delimited
JSON-RPC messages to stdout. Startup errors go to stderr with exit code 2. The CLI checks the saved switch through
the authenticated `app.info` response (`mcp_server: boolean`); an unreachable API or missing flag fails closed.
Changing the setting applies to newly started MCP processes; restart an existing MCP connection after disabling it.

Add it to Claude Code:

```sh
claude mcp add tessera -- tessera mcp
```

For a client using a JSON MCP configuration:

```json
{
  "mcpServers": {
    "tessera": {
      "command": "tessera",
      "args": ["mcp"]
    }
  }
}
```

The `tessera` executable must be on PATH (install it from Settings → General → Command-line tool). For a dev app,
use `tessera --dev mcp` / `"args": ["--dev", "mcp"]`. `TESSERA_SOCKET` and `TESSERA_API_TOKEN_FILE` override the
endpoint exactly as for the other CLI commands; authentication tokens are never included in client config.
`--force` bypasses the opt-in check for disposable tests only; it does not bypass local API authentication.
Tessera does not edit any agent configuration as part of enabling this switch.

Protocol revision: **2025-06-18**. Supports `initialize`, `notifications/initialized`, `ping`, `tools/list` and
`tools/call`. Tool inputs are JSON objects with the schemas returned by `tools/list`; unknown properties and invalid
values are rejected. Results contain one text content block with the JSON API result. Execution failures set
`isError: true` and put `{"code": <API error code>, "message": "…"}` in the text. Unknown tools are JSON-RPC
`-32602` errors; malformed JSON is `-32700`. Input messages are capped at 1 MiB.

| Tool | Local API | Arguments |
| --- | --- | --- |
| `list_projects` | `project.list` | `{}` |
| `list_tasks` | `task.list` | Optional `project`, `status` (task state). |
| `create_task` | `task.create` | Optional `project`, `prompt`, `agents` (string array), `base`, `name`. Empty project selects the only registered project. **Creates a task/worktree and may launch agents.** |
| `get_status` | `agent.status` | Required `task`. |
| `wait_status` | `agent.status` then `agent.wait` | Required `task`; optional integer `timeout` in seconds, 0–300, default 300. Returns when the observed agent status changes or the timeout expires (`timed_out: true`). |
| `send_message` | `agent.send` | Required `task`, nonempty `text`. **Writes to the task's agent and submits with Enter.** |
| `get_diff` | `review.diff` | Required `task`. |
| `read_pane` | `pane.read` | Exactly one of `task` or `session`; optional `lines` (1–5000, default 200). |

For example, after MCP initialization:

```json
{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"list_projects","arguments":{}}}
```
