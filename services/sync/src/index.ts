// Cloudflare entry: D1 storage and the GitHub lookup for the handler in handler.ts.
import { type DocBlob, type DocMeta, type GithubLookup, handle, type Storage } from "./handler";

/** The slice of Cloudflare's D1 API this Worker uses. */
interface D1Statement {
  bind(...values: unknown[]): D1Statement;
  first<T>(): Promise<T | null>;
  all<T>(): Promise<{ results: T[] }>;
  run(): Promise<{ meta: { changes: number } }>;
}
interface D1Database {
  prepare(sql: string): D1Statement;
  batch(statements: D1Statement[]): Promise<unknown>;
}

interface Env {
  DB: D1Database;
}

function d1Storage(db: D1Database): Storage {
  return {
    async userForGithub(githubId, now) {
      const existing = await db
        .prepare("SELECT id FROM users WHERE github_id = ?")
        .bind(githubId)
        .first<{ id: string }>();
      if (existing) return existing.id;
      const id = crypto.randomUUID();
      await db
        .prepare("INSERT INTO users (id, github_id, created_at) VALUES (?, ?, ?) ON CONFLICT(github_id) DO NOTHING")
        .bind(id, githubId, now)
        .run();
      const row = await db.prepare("SELECT id FROM users WHERE github_id = ?").bind(githubId).first<{ id: string }>();
      return row?.id ?? id;
    },
    async createSession(tokenHash, userId, now) {
      await db
        .prepare("INSERT INTO sessions (token_hash, user_id, created_at, last_used) VALUES (?, ?, ?, ?)")
        .bind(tokenHash, userId, now, now)
        .run();
    },
    async userForSession(tokenHash, now) {
      const row = await db
        .prepare("SELECT user_id FROM sessions WHERE token_hash = ?")
        .bind(tokenHash)
        .first<{ user_id: string }>();
      if (!row) return null;
      await db.prepare("UPDATE sessions SET last_used = ? WHERE token_hash = ?").bind(now, tokenHash).run();
      return row.user_id;
    },
    async deleteSession(tokenHash) {
      await db.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(tokenHash).run();
    },
    async listDocs(userId) {
      const { results } = await db
        .prepare("SELECT doc, version, updated_at FROM docs WHERE user_id = ? ORDER BY doc")
        .bind(userId)
        .all<DocMeta>();
      return results;
    },
    async getDoc(userId, doc) {
      return db
        .prepare("SELECT doc, version, updated_at, ciphertext, nonce FROM docs WHERE user_id = ? AND doc = ?")
        .bind(userId, doc)
        .first<DocBlob>();
    },
    async putDoc(userId, doc, baseVersion, ciphertext, nonce, now) {
      // Compare-and-swap on the version: a stale writer changes nothing and learns the current version.
      const result =
        baseVersion === 0
          ? await db
              .prepare(
                "INSERT INTO docs (user_id, doc, version, ciphertext, nonce, updated_at) VALUES (?, ?, 1, ?, ?, ?) ON CONFLICT(user_id, doc) DO NOTHING",
              )
              .bind(userId, doc, ciphertext, nonce, now)
              .run()
          : await db
              .prepare(
                "UPDATE docs SET version = version + 1, ciphertext = ?, nonce = ?, updated_at = ? WHERE user_id = ? AND doc = ? AND version = ?",
              )
              .bind(ciphertext, nonce, now, userId, doc, baseVersion)
              .run();
      if (result.meta.changes === 1) return baseVersion + 1;
      const current = await db
        .prepare("SELECT version FROM docs WHERE user_id = ? AND doc = ?")
        .bind(userId, doc)
        .first<{ version: number }>();
      return { conflict: current?.version ?? 0 };
    },
    async countDocs(userId) {
      const row = await db
        .prepare("SELECT COUNT(*) AS n FROM docs WHERE user_id = ?")
        .bind(userId)
        .first<{ n: number }>();
      return row?.n ?? 0;
    },
    async deleteAccount(userId) {
      await db.batch([
        db.prepare("DELETE FROM docs WHERE user_id = ?").bind(userId),
        db.prepare("DELETE FROM sessions WHERE user_id = ?").bind(userId),
        db.prepare("DELETE FROM users WHERE id = ?").bind(userId),
      ]);
    },
  };
}

const githubUser: GithubLookup = async (accessToken) => {
  const response = await fetch("https://api.github.com/user", {
    headers: {
      authorization: `Bearer ${accessToken}`,
      accept: "application/vnd.github+json",
      "user-agent": "tessera-sync",
    },
  });
  if (!response.ok) return null;
  const user = (await response.json()) as { id?: unknown };
  return typeof user.id === "number" ? user.id : null;
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      return await handle(request, d1Storage(env.DB), githubUser);
    } catch {
      return new Response(JSON.stringify({ error: "internal error" }), {
        status: 500,
        headers: { "content-type": "application/json" },
      });
    }
  },
};
