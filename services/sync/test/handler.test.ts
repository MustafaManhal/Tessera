import { beforeEach, describe, expect, it } from "vitest";
import { type DocBlob, handle, LIMITS, sha256Hex, type Storage } from "../src/handler";

// The sync routes against an in-memory storage with the same compare-and-swap rule as the D1 SQL.
class MemoryStorage implements Storage {
  users = new Map<number, string>();
  sessions = new Map<string, string>();
  docs = new Map<string, DocBlob & { user: string }>();
  async userForGithub(githubId: number) {
    const existing = this.users.get(githubId);
    if (existing) return existing;
    const id = `u${this.users.size + 1}`;
    this.users.set(githubId, id);
    return id;
  }
  async createSession(tokenHash: string, userId: string) {
    this.sessions.set(tokenHash, userId);
  }
  async userForSession(tokenHash: string) {
    return this.sessions.get(tokenHash) ?? null;
  }
  async deleteSession(tokenHash: string) {
    this.sessions.delete(tokenHash);
  }
  async listDocs(userId: string) {
    return [...this.docs.values()]
      .filter((d) => d.user === userId)
      .map(({ doc, version, updated_at }) => ({ doc, version, updated_at }));
  }
  async getDoc(userId: string, doc: string) {
    return this.docs.get(`${userId}/${doc}`) ?? null;
  }
  async putDoc(userId: string, doc: string, base: number, ciphertext: string, nonce: string, now: number) {
    const key = `${userId}/${doc}`;
    const current = this.docs.get(key)?.version ?? 0;
    if (current !== base) return { conflict: current };
    this.docs.set(key, { user: userId, doc, version: base + 1, updated_at: now, ciphertext, nonce });
    return base + 1;
  }
  async countDocs(userId: string) {
    return (await this.listDocs(userId)).length;
  }
  async deleteAccount(userId: string) {
    for (const [key, value] of this.docs) if (value.user === userId) this.docs.delete(key);
    for (const [key, value] of this.sessions) if (value === userId) this.sessions.delete(key);
    for (const [key, value] of this.users) if (value === userId) this.users.delete(key);
  }
}

const github = async (token: string) => (token === "gho_alice" ? 101 : token === "gho_bob" ? 202 : null);
const NONCE = "A".repeat(32);

let storage: MemoryStorage;
const call = (method: string, path: string, init: { token?: string; body?: unknown } = {}) =>
  handle(
    new Request(`https://sync.test${path}`, {
      method,
      headers: {
        ...(init.token ? { authorization: `Bearer ${init.token}` } : {}),
        ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    }),
    storage,
    github,
    1_000,
  );

async function signIn(accessToken = "gho_alice"): Promise<string> {
  const response = await call("POST", "/v1/auth/github", { body: { access_token: accessToken } });
  expect(response.status).toBe(200);
  return ((await response.json()) as { session_token: string }).session_token;
}

beforeEach(() => {
  storage = new MemoryStorage();
});

describe("sign-in", () => {
  it("issues a session for a token GitHub accepts and stores only its hash", async () => {
    const token = await signIn();
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect([...storage.sessions.keys()]).toEqual([await sha256Hex(token)]);
    expect((await call("GET", "/v1/docs", { token })).status).toBe(200);
  });

  it("refuses a token GitHub rejects, a missing token and an unknown session", async () => {
    expect((await call("POST", "/v1/auth/github", { body: { access_token: "nope" } })).status).toBe(401);
    expect((await call("POST", "/v1/auth/github", { body: {} })).status).toBe(400);
    expect((await call("GET", "/v1/docs")).status).toBe(401);
    expect((await call("GET", "/v1/docs", { token: "f".repeat(64) })).status).toBe(401);
  });

  it("signs out", async () => {
    const token = await signIn();
    expect((await call("POST", "/v1/auth/logout", { token })).status).toBe(204);
    expect((await call("GET", "/v1/docs", { token })).status).toBe(401);
  });
});

describe("documents", () => {
  it("creates, reads, updates with compare-and-swap and reports conflicts", async () => {
    const token = await signIn();
    const put = (base: number, ciphertext: string) =>
      call("PUT", "/v1/docs/settings", { token, body: { base_version: base, ciphertext, nonce: NONCE } });
    expect(await (await put(0, "c1")).json()).toEqual({ version: 1 });
    expect(await (await put(1, "c2")).json()).toEqual({ version: 2 });
    const stale = await put(1, "c3");
    expect(stale.status).toBe(409);
    expect(await stale.json()).toEqual({ version: 2 });
    expect(await (await call("GET", "/v1/docs/settings", { token })).json()).toEqual({
      doc: "settings",
      version: 2,
      ciphertext: "c2",
      nonce: NONCE,
    });
    expect(await (await call("GET", "/v1/docs", { token })).json()).toEqual([
      { doc: "settings", version: 2, updated_at: 1_000 },
    ]);
    expect((await call("GET", "/v1/docs/missing", { token })).status).toBe(404);
  });

  it("keeps accounts apart", async () => {
    const alice = await signIn("gho_alice");
    const bob = await signIn("gho_bob");
    await call("PUT", "/v1/docs/settings", { token: alice, body: { base_version: 0, ciphertext: "a", nonce: NONCE } });
    expect((await call("GET", "/v1/docs/settings", { token: bob })).status).toBe(404);
    expect(await (await call("GET", "/v1/docs", { token: bob })).json()).toEqual([]);
  });

  it("rejects bad names, bad nonces, oversized documents and too many documents", async () => {
    const token = await signIn();
    const put = (doc: string, body: unknown) => call("PUT", `/v1/docs/${doc}`, { token, body });
    expect((await put("Bad_Name", { base_version: 0, ciphertext: "x", nonce: NONCE })).status).toBe(400);
    expect((await put("settings", { base_version: 0, ciphertext: "x", nonce: "short" })).status).toBe(400);
    expect((await put("settings", { base_version: -1, ciphertext: "x", nonce: NONCE })).status).toBe(400);
    const big = "x".repeat(LIMITS.ciphertext + 1);
    expect((await put("settings", { base_version: 0, ciphertext: big, nonce: NONCE })).status).toBe(413);
    for (let i = 0; i < LIMITS.docs; i += 1) {
      expect((await put(`d${i}`, { base_version: 0, ciphertext: "x", nonce: NONCE })).status).toBe(200);
    }
    expect((await put("one-more", { base_version: 0, ciphertext: "x", nonce: NONCE })).status).toBe(413);
  });

  it("deletes the account with every document and session", async () => {
    const token = await signIn();
    await call("PUT", "/v1/docs/settings", { token, body: { base_version: 0, ciphertext: "a", nonce: NONCE } });
    expect((await call("DELETE", "/v1/account", { token })).status).toBe(204);
    expect(storage.docs.size).toBe(0);
    expect(storage.users.size).toBe(0);
    expect((await call("GET", "/v1/docs", { token })).status).toBe(401);
  });

  it("answers health without a session and 404 elsewhere", async () => {
    expect(await (await call("GET", "/v1/health")).json()).toEqual({ ok: true });
    const token = await signIn();
    expect((await call("GET", "/v2/anything", { token })).status).toBe(404);
  });
});
