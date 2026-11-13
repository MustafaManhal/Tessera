# Local API (M6.3)

The desktop listens on `<data dir>/tessera.sock` (macOS, mode 0600) or
`\\.\pipe\tessera-<data-folder hash>` (Windows). `api-token` is a fresh random
256-bit token, user-only on macOS and in the user's data directory on Windows.
A second server cannot replace a live server's token. Token values are never logged.

Each connection carries one newline-terminated JSON-RPC 2.0 request or batch;
maximum encoded line size is 1 MiB. Each request object carries `auth`, `method`,
`params` and an optional `id`. Notifications omit `id` and receive no response.
The client sends `api_version: 1` as an extension field. Responses contain either
`result` or `error`. Invalid/missing authentication is `-32001`; missing records
are `-32002`; unavailable state is `-32003`. Standard parse/request/method/params/
internal errors use the JSON-RPC codes. Slow clients use independent threads;
idle I/O and response sizes are bounded. At most 64 client workers are admitted.

Implemented desktop methods:

- `app.info`: no params, returns `version` and `api_version`.
- `app.notify`: `title`, `body`; uses the native OS notification plugin.
- `hook.event`: `tessera_session_id`, `agent`, `event`, `payload`, `at` (Unix ms).
  Looks up the latest agent session bound to that PTY, appends the complete hook
  params (including unmodified vendor JSON under `payload`) and emits the session.

PTYs receive `TESSERA_SOCKET` and `TESSERA_API_TOKEN_FILE`, never the token itself.
CLI endpoint overrides use those same names; otherwise `--dev` selects Tessera Dev
and the default is Tessera in the platform user data directory.

`tessera info` and `tessera notify "title" "body"` print the JSON result. Hook mode
reads JSON from stdin and is silent, always exits zero, and has a two-second total
budget including stdin. Without `TESSERA_SESSION_ID` it returns before reading.
`TESSERA_DEBUG` enables diagnostic stderr only. The hook does not wait for stdin
forever when a producer fails to close it.

CLI PATH installation is a separate explicit desktop command, never automatic;
its consent UI is a later task. No sudo or machine PATH writes are used.

Protocol reference read 2026-11-11: https://www.jsonrpc.org/specification
