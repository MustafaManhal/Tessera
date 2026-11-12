# Releasing Tessera

What is automatic, what is manual, and the order. Nothing here publishes by itself: the Release workflow only makes a
**draft** that you read and publish by hand.

## Decisions this follows

- macOS: ad hoc signed, not notarized (no Apple Developer account, D-13). The first start needs a right-click, Open (or
  `xattr -d com.apple.quarantine`). The download page says so.
- Windows: installers are unsigned until SignPath approves the project (D-14). SmartScreen shows a warning meanwhile.
- Update bundles are always signed with the updater key. The public key is in `tauri.conf.json`; the private key and its
  password are the repository secrets `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`.
- Installers are at most 25 MB each (NFR-05); the workflows run `scripts/size-check.mjs`.

## Steps

1. On the private workspace: everything merged, `pnpm check` green, `docs/performance.md` numbers current, a release
   entry added to `apps/desktop/src/updates/whatsnew.ts`, the version raised in `tauri.conf.json` and the crates.
2. Refresh the licence list: `node scripts/licenses.mjs`.
3. Export to the public repository (never push the workspace there):
   `node scripts/publish-public.mjs` (dry run), then `node scripts/publish-public.mjs --push git@github.com:MustafaManhal/Tessera.git`.
4. Optional, on the public repo: run **Package check** (Actions) to see the installers build on macOS (universal),
   Windows x64 and Windows arm64 with sizes.
5. Run **Release** (Actions, Run workflow): version tag (`v0.1.0`), channel `stable` or `beta`. It builds all three,
   signs the update bundles, checks sizes, writes `latest.json` and creates a **draft** release.
6. Open the draft: check the files (three installers, the update bundles with their `.sig`, `latest.json`), edit the
   notes, press **Publish**. A published non-draft release becomes `releases/latest`, which is where stable clients look
   (`latest.json`). The beta channel is a rolling pre-release tagged `beta`.
7. Test an update from the previous build (see `docs/release-check.md`).

## Local dry run

`pnpm release:dry-run` builds the macOS app bundle for this machine, makes a `.dmg` with `hdiutil` and prints the
sizes. It needs no key and uploads nothing. (Tauri's own `.dmg` step styles the window through Finder, which needs a
logged-in desktop, so the dry run avoids it; the CI runner uses Tauri's.)

## Adding Windows signing later (SignPath)

After SignPath approves the project: add their GitHub Action after the Windows build step in `release.yml`, upload
the unsigned installer to it and use the signed file it returns. Then re-run **Package check**.

## Manifest format

`scripts/release-manifest.mjs` writes `latest.json` as tauri-plugin-updater expects it: `version`, `notes`, `pub_date`
and `platforms` with `signature` and `url` per `darwin-aarch64`, `darwin-x86_64`, `windows-x86_64`, `windows-aarch64`.
