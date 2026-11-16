// Network audit (M12.4, NFR-08): Tessera talks to the network only for updates, integrations (GitHub, Linear, the
// user's own MCP servers) and sync. This script fails when
//   1. network-capable code (an HTTP client, sockets, `fetch`, WebSocket) appears in a file that is not listed in
//      ALLOWED_FILES with its reason, or
//   2. a source file mentions a host that is not in ALLOWED_HOSTS.
// Run `node scripts/network-audit.mjs`; `pnpm test` runs it through tests/unit/network-audit.test.ts.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));

/** File (relative, forward slashes) → why it may talk to the network. */
export const ALLOWED_FILES = {
  "crates/tessera-forge/src/github.rs": "GitHub integration (device flow, REST)",
  "crates/tessera-forge/src/issues.rs": "GitHub and Linear issues",
  "crates/tessera-forge/src/pulls.rs": "GitHub pull requests and checks",
  "crates/tessera-sync/src/transport.rs": "optional encrypted sync",
  "crates/tessera-sync/src/github.rs": "sync sign-in with GitHub",
  "crates/tessera-sync/src/feedback.rs": "feedback the person chose to send (screenshots, reports)",
  "apps/desktop/src-tauri/src/sync_commands.rs": "optional encrypted sync",
  "apps/desktop/src-tauri/src/update_commands.rs": "signed updates",
  "crates/tessera-agents/src/mcp_probe.rs": "the user's own 'Test' of an MCP server (curl), only when pressed",
  "crates/tessera-store/src/task_ports.rs": "probing local ports of a task (127.0.0.1 only)",
  "apps/desktop/src-tauri/src/pr_smoke.rs": "debug-only native check against a local mock server",
  "crates/tessera-pty/examples/pty_bridge.rs": "development PTY bridge on localhost",
  "apps/desktop/src/terminal/ptyClient.tsx": "development PTY bridge on localhost",
  "packages/term/src/pty/websocket.ts": "development PTY bridge on localhost",
  "packages/term/tests/pty/websocket.test.ts": "tests of the development bridge",
};

/** Hosts the source may mention: services Tessera calls, documentation links opened by a click, test placeholders. */
export const ALLOWED_HOSTS = new Set([
  "github.com",
  "api.github.com",
  "api.linear.app",
  "linear.app",
  "tessera-sync.calli-worker.workers.dev",
  "127.0.0.1",
  "localhost",
  "tessera.dev",
  // Documentation links of agents and tools (opened in the browser by the user).
  "opencode.ai",
  "docs.factory.ai",
  "docs.claude.com",
  "cursor.com",
  "ampcode.com",
  "aider.chat",
  "sw.kovidgoyal.net",
  // XML/SVG namespaces and test placeholders: never contacted.
  "www.w3.org",
  "example.com",
  "example.invalid",
  "sync.example",
  "gitlab.com",
]);

const CODE_PATTERNS = [
  /\breqwest\b/,
  /\bhyper::/,
  /\bureq\b/,
  /\bTcpStream\b/,
  /\bTcpListener\b/,
  /\bUdpSocket\b/,
  /\bupdater_builder\b/,
  /\bstd::net\b/,
  /\bfetch\s*\(/,
  /\bXMLHttpRequest\b/,
  /\bnew\s+WebSocket\b/,
  /\bsendBeacon\b/,
  /\bEventSource\b/,
];
const SCAN_DIRS = ["apps/desktop/src", "apps/desktop/src-tauri/src", "packages", "crates"];
const SKIP = new Set(["spikes", "node_modules", "target", "dist", "dist-ssr", ".git", "gen"]);
const EXTENSIONS = new Set([".rs", ".ts", ".tsx", ".mjs", ".js"]);

function* files(dir) {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const path = join(dir, name);
    const stat = statSync(path);
    if (stat.isDirectory()) yield* files(path);
    else if (EXTENSIONS.has(name.slice(name.lastIndexOf(".")))) yield path;
  }
}

/** Hosts (with a dot) named by `http(s)://` literals in a text. */
export function hostsIn(text) {
  const found = new Set();
  for (const match of text.matchAll(/https?:\/\/(?:[^\s/@'"`]+@)?([A-Za-z0-9.-]+)/g)) {
    const host = (match[1] ?? "").replace(/\.$/, "").toLowerCase();
    // Placeholders such as "https://user:pw@" or "https://x" have no dot and are not hosts.
    if (host.includes(".") || host === "localhost") found.add(host);
  }
  return found;
}

export function networkCodeIn(text) {
  return CODE_PATTERNS.some((pattern) => pattern.test(text));
}

export function scan(base = root) {
  const violations = [];
  for (const dir of SCAN_DIRS) {
    let start;
    try {
      start = join(base, dir);
      statSync(start);
    } catch {
      continue;
    }
    for (const path of files(start)) {
      const rel = relative(base, path).split("\\").join("/");
      // The audit itself and its test name the patterns on purpose.
      if (rel.startsWith("scripts/") || rel.includes("network-audit")) continue;
      const text = readFileSync(path, "utf8");
      if (networkCodeIn(text) && !(rel in ALLOWED_FILES))
        violations.push(`${rel}: network code in a file that is not on the allow-list`);
      for (const host of hostsIn(text)) {
        if (!ALLOWED_HOSTS.has(host)) violations.push(`${rel}: host ${host} is not on the allow-list`);
      }
    }
  }
  return violations;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const violations = scan();
  if (violations.length > 0) {
    console.error(`network audit failed:\n${violations.map((v) => `  ${v}`).join("\n")}`);
    process.exit(1);
  }
  console.log("network audit: only the allowed files and hosts");
}
