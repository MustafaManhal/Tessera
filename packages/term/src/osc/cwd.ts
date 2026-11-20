// OSC 7 `file://host/path`: the shell's working directory (FR-17, FR-25).
// - The path is percent-decoded; a malformed escape, a relative path or a control character rejects the sequence.
// - `file:///C:/Users/x` (and `file://host/C:/…`) is a Windows drive path: `C:/Users/x`.
// - `file:////server/share/x` and `file://host//server/share/x` are UNC paths: `\\server\share\x`.
// - Host: empty, `localhost`, or a host the pane trusts. A shell reports its own host name (`file://my-mac.local/…`),
//   so a pane trusts the host of the first OSC 7 its own shell prints (`createCwdFilter`); a later sequence from a
//   different host (an SSH session) is ignored, so new tabs never open in a folder that exists on another machine.

export interface Osc7Location {
  /** Lower-cased host, "" when the URL had none. */
  host: string;
  path: string;
}

/** Parses an OSC 7 payload; null when it is not a usable `file://` URL. */
export function parseOsc7Url(data: string): Osc7Location | null {
  if (!data.toLowerCase().startsWith("file://")) return null;
  const rest = data.slice("file://".length);
  const slash = rest.indexOf("/");
  if (slash < 0) return null;
  const host = rest.slice(0, slash).toLowerCase();
  if (!/^[a-z0-9._-]*$/.test(host)) return null;
  let path: string;
  try {
    path = decodeURIComponent(rest.slice(slash));
  } catch {
    return null;
  }
  for (const char of path) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return null;
  }
  if (path.startsWith("//")) {
    // UNC: //server/share[/rest]
    const parts = path.slice(2).split("/");
    const [server, share] = parts;
    if (!server || !share) return null;
    return { host, path: `\\\\${parts.filter((part) => part !== "").join("\\")}` };
  }
  if (/^\/[A-Za-z]:(\/|$)/.test(path)) return { host, path: path.slice(1) || path };
  return { host, path };
}

const LOCAL_HOSTS = new Set(["", "localhost", "127.0.0.1", "::1"]);

export interface CwdFilter {
  /** The path to use for an OSC 7 payload, or null to ignore it. */
  accept(data: string): string | null;
  /** The host this pane trusts besides localhost (tests). */
  readonly trustedHost: string | null;
}

/** Per pane: trusts localhost, `localHosts`, and the host of the first OSC 7 it sees. */
export function createCwdFilter(localHosts: readonly string[] = []): CwdFilter {
  const known = new Set([...LOCAL_HOSTS, ...localHosts.map((host) => host.toLowerCase())]);
  let trusted: string | null = null;
  return {
    get trustedHost() {
      return trusted;
    },
    accept(data) {
      const location = parseOsc7Url(data);
      if (!location) return null;
      if (known.has(location.host)) return location.path;
      if (trusted === null) {
        trusted = location.host;
        return location.path;
      }
      return location.host === trusted ? location.path : null;
    },
  };
}

/** One-shot parse that accepts any host (kept for callers without a filter). */
export function parseOsc7(data: string): string | null {
  return parseOsc7Url(data)?.path ?? null;
}
