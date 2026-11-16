# Tessera sync server

A Cloudflare Worker with a D1 database that stores end-to-end encrypted, versioned blobs for Tessera's optional sync
(M11). The server never sees plaintext or a key; GitHub is only asked who a sign-in token belongs to, and only the
numeric account id is kept. API: `src/handler.ts` (and `05-backend-schema.md` §8).

## Deploy (owner)

```sh
cd services/sync
npx wrangler@4.154.0 d1 migrations apply tessera-sync --remote   # new migrations only
npx wrangler@4.154.0 deploy
curl https://<worker>.workers.dev/v1/health                      # {"ok":true}
```

No secrets are needed: sessions are random tokens stored as SHA-256 hashes, and the GitHub token from the app's
device-flow sign-in is used once to read the account id.

## Test

`pnpm test` runs `test/handler.test.ts` (routes against an in-memory store with the same compare-and-swap rule).
