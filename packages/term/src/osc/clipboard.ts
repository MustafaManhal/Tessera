// OSC 52 clipboard requests (FR-08): `OSC 52 ; Pc ; Pd ST`, Pc the selection targets (c, p, q, s, 0–7; empty means
// "s 0"), Pd base64 text or `?` to read. Reads would hand the clipboard to any program, including one on the far side
// of an SSH connection, so they are always blocked. Writes follow the `terminal.osc52_write` policy.

/** Largest text a program may copy (decoded bytes). */
export const OSC52_MAX_BYTES = 1024 * 1024;

export type Osc52Policy = "ask" | "allow" | "deny";

export type Osc52Request =
  | { kind: "write"; text: string }
  | { kind: "read" }
  | { kind: "tooLarge"; bytes: number }
  /** An empty Pd: "clear the selection". We leave the clipboard alone. */
  | { kind: "clear" }
  | { kind: "invalid" };

const TARGETS = /^[cpqs0-7]*$/;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/** Parses the payload after `52;`. */
export function parseOsc52(data: string): Osc52Request {
  const split = data.indexOf(";");
  if (split < 0) return { kind: "invalid" };
  const targets = data.slice(0, split);
  const payload = data.slice(split + 1);
  if (!TARGETS.test(targets)) return { kind: "invalid" };
  if (payload === "?") return { kind: "read" };
  if (payload === "") return { kind: "clear" };
  if (!BASE64.test(payload) || payload.length % 4 === 1) return { kind: "invalid" };
  // Size from the encoded length, before decoding anything big.
  const padding = payload.endsWith("==") ? 2 : payload.endsWith("=") ? 1 : 0;
  const bytes = Math.floor((payload.length * 3) / 4) - padding;
  if (bytes > OSC52_MAX_BYTES) return { kind: "tooLarge", bytes };
  try {
    const binary = atob(payload);
    const decoded = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return { kind: "write", text: new TextDecoder().decode(decoded) };
  } catch {
    return { kind: "invalid" };
  }
}

/** What the pane does with a request: write now, ask the user, or drop it. */
export type Osc52Decision = "write" | "ask" | "drop";

export function decideOsc52(request: Osc52Request, policy: Osc52Policy): Osc52Decision {
  if (request.kind !== "write") return "drop";
  if (policy === "allow") return "write";
  if (policy === "ask") return "ask";
  return "drop";
}
