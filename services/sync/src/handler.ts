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

export interface Storage {
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

export async function handle(request: Request, storage: Storage, github: GithubLookup, now = Date.now()) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "");
  const method = request.method;

  if (method === "GET" && path === "/v1/health") return json(200, { ok: true });

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
