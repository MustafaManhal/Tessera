// The Tessera sync API (05-backend-schema §8). Storage and the GitHub lookup are passed in, so the routes are
// unit-tested without Cloudflare (test/handler.test.ts) and src/index.ts only wires D1 and fetch.
//
//   POST   /v1/auth/github   {access_token}            → {session_token, user_id}   (401 when GitHub rejects it)
//   POST   /v1/auth/logout                              → 204
//   GET    /v1/docs                                     → [{doc, version, updated_at}]
//   GET    /v1/docs/{doc}                               → {doc, version, ciphertext, nonce}   (404)
//   PUT    /v1/docs/{doc}    {base_version, ciphertext, nonce} → {version}   (409 {version} when base is stale)
//   DELETE /v1/account                                  → 204 (every document, session and the account row)
//   GET    /v1/health                                   → {ok: true}
//
// The server never sees plaintext and keeps nothing from GitHub but the numeric account id.

export interface DocMeta {
  doc: string;
  version: number;
  updated_at: number;
}

export interface DocBlob extends DocMeta {
  ciphertext: string;
  nonce: string;
}

export interface FeedbackAttachment {
  name: string;
  mime: string;
  data_base64: string;
}

export interface FeedbackInput {
  kind: "bug" | "idea" | "design" | "other";
  title: string;
  body: string;
  contact: string;
  app_version: string;
  os: string;
  report: string;
  attachments: FeedbackAttachment[];
}

export interface Storage {
  /** Stores one piece of feedback with its screenshots. `senderHash` only serves the rate limit. */
  saveFeedback(id: string, input: FeedbackInput, senderHash: string, now: number): Promise<void>;
  /** How many pieces of feedback this sender hash sent since `since` (ms). */
  feedbackCountSince(senderHash: string, since: number): Promise<number>;
  userForGithub(githubId: number, now: number): Promise<string>;
  createSession(tokenHash: string, userId: string, now: number): Promise<void>;
  userForSession(tokenHash: string, now: number): Promise<string | null>;
  deleteSession(tokenHash: string): Promise<void>;
  listDocs(userId: string): Promise<DocMeta[]>;
  getDoc(userId: string, doc: string): Promise<DocBlob | null>;
  /** Writes when `baseVersion` is current; returns the new version, or `{conflict: current}`. */
  putDoc(
    userId: string,
    doc: string,
    baseVersion: number,
    ciphertext: string,
    nonce: string,
    now: number,
  ): Promise<number | { conflict: number }>;
  countDocs(userId: string): Promise<number>;
  deleteAccount(userId: string): Promise<void>;
}

/** Who a GitHub token belongs to, or null when GitHub rejects it. */
export type GithubLookup = (accessToken: string) => Promise<number | null>;

export const LIMITS = {
  /** Base64 of 1 MiB. */
  ciphertext: 1_398_104,
  docs: 64,
  doc: /^[a-z0-9][a-z0-9-]{0,63}$/,
  /** Base64 of 24 bytes. */
  nonce: /^[A-Za-z0-9+/]{32}$/,
} as const;

/** What the feedback form may send. Screenshots are shrunk by the app; these are the hard limits. */
export const FEEDBACK_LIMITS = {
  title: 140,
  body: 8_000,
  contact: 200,
  report: 60_000,
  version: 40,
  os: 80,
  attachments: 3,
  /** Base64 of about 600 KB, per screenshot. */
  attachment: 800_000,
  /** The whole request. */
  request: 2_600_000,
  perHour: 5,
  kinds: ["bug", "idea", "design", "other"],
  mimes: ["image/png", "image/jpeg", "image/webp"],
} as const;

const json = (status: number, body: unknown) =>
  new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers: body === null ? {} : { "content-type": "application/json" },
  });

const fail = (status: number, error: string) => json(status, { error });

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

function newToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

async function body(request: Request): Promise<Record<string, unknown> | null> {
  const length = Number(request.headers.get("content-length") ?? "0");
  if (length > LIMITS.ciphertext + 4096) return null;
  try {
    const text = await request.text();
    if (text.length > LIMITS.ciphertext + 4096) return null;
    const value: unknown = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Checks a feedback body; the text is the error to show, or the clean input. */
export function parseFeedback(value: Record<string, unknown>): FeedbackInput | string {
  const text = (key: string, max: number, required: boolean): string | null => {
    const v = value[key];
    if (v === undefined || v === null || v === "") return required ? null : "";
    return typeof v === "string" && v.length <= max ? v : null;
  };
  const kind = value.kind;
  if (typeof kind !== "string" || !(FEEDBACK_LIMITS.kinds as readonly string[]).includes(kind)) return "unknown kind";
  const title = text("title", FEEDBACK_LIMITS.title, true);
  const body = text("body", FEEDBACK_LIMITS.body, true);
  const contact = text("contact", FEEDBACK_LIMITS.contact, false);
  const version = text("app_version", FEEDBACK_LIMITS.version, false);
  const os = text("os", FEEDBACK_LIMITS.os, false);
  const report = text("report", FEEDBACK_LIMITS.report, false);
  if (title === null || title.trim() === "") return "a title is required (at most 140 characters)";
  if (body === null || body.trim() === "") return "a description is required (at most 8000 characters)";
  if (contact === null || version === null || os === null || report === null) return "a field is too long";
  const rawAttachments = value.attachments ?? [];
  if (!Array.isArray(rawAttachments) || rawAttachments.length > FEEDBACK_LIMITS.attachments)
    return "too many screenshots";
  const attachments: FeedbackAttachment[] = [];
  for (const item of rawAttachments) {
    const a = item as Record<string, unknown>;
    if (
      !a ||
      typeof a.name !== "string" ||
      a.name.length > 120 ||
      typeof a.mime !== "string" ||
      !(FEEDBACK_LIMITS.mimes as readonly string[]).includes(a.mime) ||
      typeof a.data_base64 !== "string" ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(a.data_base64) ||
      a.data_base64.length > FEEDBACK_LIMITS.attachment
    )
      return "a screenshot is not valid or is too large";
    attachments.push({ name: a.name, mime: a.mime, data_base64: a.data_base64 });
  }
  return {
    kind: kind as FeedbackInput["kind"],
    title: title.trim(),
    body: body.trim(),
    contact,
    app_version: version,
    os,
    report,
    attachments,
  };
}

export async function handle(request: Request, storage: Storage, github: GithubLookup, now = Date.now()) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "");
  const method = request.method;

  if (method === "GET" && path === "/v1/health") return json(200, { ok: true });

  // Feedback needs no account: a person pressing Send in the app. Rate limited per sender, never stores the address.
  if (method === "POST" && path === "/v1/feedback") {
    const length = Number(request.headers.get("content-length") ?? "0");
    if (length > FEEDBACK_LIMITS.request) return fail(413, "the report is too large");
    let value: unknown;
    try {
      const text = await request.text();
      if (text.length > FEEDBACK_LIMITS.request) return fail(413, "the report is too large");
      value = JSON.parse(text);
    } catch {
      return fail(400, "not JSON");
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) return fail(400, "not an object");
    const parsed = parseFeedback(value as Record<string, unknown>);
    if (typeof parsed === "string") return fail(400, parsed);
    const sender = await sha256Hex(`tessera-feedback:${request.headers.get("cf-connecting-ip") ?? "unknown"}`);
    if ((await storage.feedbackCountSince(sender, now - 3_600_000)) >= FEEDBACK_LIMITS.perHour) {
      return fail(429, "too many reports from this address; try again later");
    }
    const id = `F-${newToken().slice(0, 8)}`;
    await storage.saveFeedback(id, parsed, sender, now);
    return json(200, { id });
  }

  if (method === "POST" && path === "/v1/auth/github") {
    const input = await body(request);
    const accessToken = typeof input?.access_token === "string" ? input.access_token : "";
    if (!accessToken) return fail(400, "access_token is required");
    const githubId = await github(accessToken);
    if (githubId === null) return fail(401, "GitHub did not accept the token");
    const userId = await storage.userForGithub(githubId, now);
    const token = newToken();
    await storage.createSession(await sha256Hex(token), userId, now);
    return json(200, { session_token: token, user_id: userId });
  }

  const bearer = /^Bearer ([0-9a-f]{64})$/.exec(request.headers.get("authorization") ?? "")?.[1];
  if (!bearer) return fail(401, "sign in first");
  const tokenHash = await sha256Hex(bearer);
  const userId = await storage.userForSession(tokenHash, now);
  if (!userId) return fail(401, "the session ended; sign in again");

  if (method === "POST" && path === "/v1/auth/logout") {
    await storage.deleteSession(tokenHash);
    return json(204, null);
  }
  if (method === "DELETE" && path === "/v1/account") {
    await storage.deleteAccount(userId);
    return json(204, null);
  }
  if (method === "GET" && path === "/v1/docs") return json(200, await storage.listDocs(userId));

  const doc = /^\/v1\/docs\/([^/]+)$/.exec(path)?.[1];
  if (doc !== undefined) {
    if (!LIMITS.doc.test(doc)) return fail(400, "invalid document name");
    if (method === "GET") {
      const found = await storage.getDoc(userId, doc);
      return found
        ? json(200, { doc, version: found.version, ciphertext: found.ciphertext, nonce: found.nonce })
        : fail(404, "no such document");
    }
    if (method === "PUT") {
      const input = await body(request);
      if (!input) return fail(413, "the document is too large or not JSON");
      const { base_version: baseVersion, ciphertext, nonce } = input;
      if (
        typeof baseVersion !== "number" ||
        !Number.isInteger(baseVersion) ||
        baseVersion < 0 ||
        typeof ciphertext !== "string" ||
        typeof nonce !== "string" ||
        !LIMITS.nonce.test(nonce) ||
        ciphertext.length === 0
      ) {
        return fail(400, "base_version, ciphertext and nonce are required");
      }
      if (ciphertext.length > LIMITS.ciphertext) return fail(413, "the document is larger than 1 MiB");
      if (baseVersion === 0 && (await storage.countDocs(userId)) >= LIMITS.docs) {
        return fail(413, "too many documents");
      }
      const result = await storage.putDoc(userId, doc, baseVersion, ciphertext, nonce, now);
      return typeof result === "number" ? json(200, { version: result }) : json(409, { version: result.conflict });
    }
  }
  return fail(404, "not found");
}
