// Notifications and progress a program asks for with escape sequences (FR-10, FR-11). Pure parsers; the app decides
// whether and how to show them (NotificationService).
//
// - OSC 9 ; <text>                       iTerm2 notification. `OSC 9 ; <n> ; …` with n = 1–12 is ConEmu's family
//                                        (9;4 progress, 9;9 cwd); never a notification.
// - OSC 777 ; notify ; <title> ; <body>  rxvt-unicode / VTE / foot.
// - OSC 99 ; <metadata> ; <payload>      kitty (https://sw.kovidgoyal.net/kitty/desktop-notifications/): metadata is
//                                        `key=value` pairs joined by `:`, chunks with `d=0` share an id `i`.
// - OSC 9 ; 4 ; <state> ; <progress>     ConEmu progress: 0 remove, 1 set 0–100, 2 error, 3 indeterminate, 4 paused.

/** Longest notification text we accept (characters); longer sequences are dropped, not cut. */
export const NOTIFY_MAX_CHARS = 2048;

export interface NotificationRequest {
  /** Empty when the program gave only a body (OSC 9). */
  title: string;
  body: string;
  /** kitty `o` (default "always"): "unfocused" means not even an in-app toast while the pane is being looked at. */
  occasion: "always" | "unfocused" | "invisible";
  /** kitty `u`: 0 low, 1 normal, 2 critical. */
  urgency: 0 | 1 | 2;
}

export type ProgressState = "normal" | "error" | "indeterminate" | "paused";

/** OSC 9;4. `value` is 0–100, or null for "keep the previous value" (error and paused without a number). */
export type ProgressRequest = { kind: "clear" } | { kind: "set"; state: ProgressState; value: number | null };

export type Osc9Result =
  | { kind: "notify"; request: NotificationRequest }
  | { kind: "progress"; request: ProgressRequest }
  | { kind: "cwd"; path: string }
  | null;

/** Replaces control characters (C0, DEL, C1) with spaces and trims: notification text is shown, never interpreted. */
export function cleanText(text: string): string {
  let out = "";
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    out += code < 0x20 || (code >= 0x7f && code < 0xa0) ? " " : char;
  }
  return out.replace(/ {2,}/g, " ").trim();
}

function request(title: string, body: string, extra: Partial<NotificationRequest> = {}): NotificationRequest | null {
  if (title.length + body.length > NOTIFY_MAX_CHARS) return null;
  const cleanTitle = cleanText(title);
  const cleanBody = cleanText(body);
  if (cleanTitle === "" && cleanBody === "") return null;
  return { title: cleanTitle, body: cleanBody, occasion: "always", urgency: 1, ...extra };
}

const INTEGER = /^\d{1,3}$/;

/** OSC 9;4;st;pr (the part after `9;4;`). */
export function parseProgress(data: string): ProgressRequest | null {
  const [stateText = "", valueText, ...extra] = data.split(";");
  if (extra.length > 0 || !INTEGER.test(stateText)) return null;
  const state = Number(stateText);
  let value: number | null = null;
  if (valueText !== undefined && valueText !== "") {
    if (!INTEGER.test(valueText)) return null;
    value = Math.min(100, Number(valueText));
  }
  switch (state) {
    case 0:
      return { kind: "clear" };
    case 1:
      return { kind: "set", state: "normal", value: value ?? 0 };
    case 2:
      return { kind: "set", state: "error", value };
    case 3:
      return { kind: "set", state: "indeterminate", value: null };
    case 4:
      return { kind: "set", state: "paused", value };
    default:
      return null;
  }
}

/** OSC 9 payload (the part after `9;`). */
export function parseOsc9(data: string): Osc9Result {
  const conemu = /^(\d{1,2});/.exec(data) ?? (/^\d{1,2}$/.test(data) ? [data, data] : null);
  if (conemu) {
    const code = Number(conemu[1]);
    if (code >= 1 && code <= 12) {
      const rest = data.slice(conemu[0].length);
      if (code === 4) {
        const progress = parseProgress(rest);
        return progress ? { kind: "progress", request: progress } : null;
      }
      if (code === 9) {
        // ConEmu cwd: OSC 9;9;"C:\path" (quotes optional).
        const path = rest.replace(/^"(.*)"$/, "$1");
        return path && cleanText(path) === path ? { kind: "cwd", path } : null;
      }
      return null;
    }
  }
  const notification = request("", data);
  return notification ? { kind: "notify", request: notification } : null;
}

/** OSC 777 payload (the part after `777;`): only `notify;title;body`. */
export function parseOsc777(data: string): NotificationRequest | null {
  if (!data.startsWith("notify;")) return null;
  const rest = data.slice("notify;".length);
  const split = rest.indexOf(";");
  const title = split < 0 ? rest : rest.slice(0, split);
  const body = split < 0 ? "" : rest.slice(split + 1);
  return request(title, body);
}

// kitty OSC 99 ------------------------------------------------------------------------------------------------------

interface Pending {
  title: string;
  body: string;
  occasion: NotificationRequest["occasion"];
  urgency: NotificationRequest["urgency"];
}

export interface KittyNotifications {
  /** Feeds an OSC 99 payload; returns a complete notification, or null while chunks are pending or on bad input. */
  feed(data: string): NotificationRequest | null;
  /** Ids with chunks still waiting for `d=1` (tests). */
  readonly pending: number;
}

const META_KEY = /^[a-z]$/;
const META_VALUE = /^[A-Za-z0-9_\-+.,=/]*$/;
/** Ids waiting for more chunks; the oldest is dropped past this. */
const MAX_PENDING = 8;

function decodeBase64(text: string): string | null {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(text) || text.length % 4 === 1) return null;
  try {
    const binary = atob(text);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
}

export function createKittyNotifications(): KittyNotifications {
  const pending = new Map<string, Pending>();
  return {
    get pending() {
      return pending.size;
    },
    feed(data) {
      const split = data.indexOf(";");
      if (split < 0) return null;
      const metadata = data.slice(0, split);
      let payload = data.slice(split + 1);
      if (payload.length > NOTIFY_MAX_CHARS * 2) return null;
      const meta = new Map<string, string>();
      if (metadata !== "") {
        for (const pair of metadata.split(":")) {
          const eq = pair.indexOf("=");
          if (eq < 1) return null;
          const key = pair.slice(0, eq);
          const value = pair.slice(eq + 1);
          if (!META_KEY.test(key) || !META_VALUE.test(value)) return null;
          meta.set(key, value);
        }
      }
      const id = meta.get("i") ?? "";
      const type = meta.get("p") ?? "title";
      if (type === "close") {
        pending.delete(id);
        return null;
      }
      // Queries (`?`), icons, buttons and "alive" checks are not answered: the program sees no support for them.
      if (type !== "title" && type !== "body") return null;
      if (meta.get("e") === "1") {
        const decoded = decodeBase64(payload);
        if (decoded === null) return null;
        payload = decoded;
      }
      const occasionText = meta.get("o");
      const urgencyText = meta.get("u");
      let entry = pending.get(id);
      if (!entry) {
        entry = { title: "", body: "", occasion: "always", urgency: 1 };
        pending.set(id, entry);
        while (pending.size > MAX_PENDING) pending.delete(pending.keys().next().value as string);
      }
      if (occasionText === "always" || occasionText === "unfocused" || occasionText === "invisible")
        entry.occasion = occasionText;
      if (urgencyText === "0" || urgencyText === "1" || urgencyText === "2")
        entry.urgency = Number(urgencyText) as 0 | 1 | 2;
      if (type === "title") entry.title += payload;
      else entry.body += payload;
      if (entry.title.length + entry.body.length > NOTIFY_MAX_CHARS) {
        pending.delete(id);
        return null;
      }
      if (meta.get("d") === "0") return null;
      pending.delete(id);
      return request(entry.title, entry.body, { occasion: entry.occasion, urgency: entry.urgency });
    },
  };
}
