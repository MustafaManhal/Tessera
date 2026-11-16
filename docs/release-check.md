# v1 release check

The sign-off page for v1. `node scripts/release-check.mjs` prints every row below with pass, fail or manual (`--full`
also runs `pnpm check` and `pnpm test:ui`). A row that needs a person, a Windows machine or a published release is
manual: its evidence and what to do is written here.

## Criteria (PRD §12) and where each is proven

| Criterion | Evidence | State |
| --- | --- | --- |
| Every Must feature works on macOS and Windows, checked in the running app | macOS: `pnpm check`, `pnpm test:ui`, native runs recorded in each brief report. Windows: the proof workflows **Windows 1** (Rust core), **Windows 3** (UI), **Windows 4** (real app), **Windows 6** (SSH) must be green on the release commit | manual: read the latest runs |
| NFR-01 to NFR-04, NFR-06, NFR-13 measured and met | `docs/performance.md` (macOS, this machine) and the **Windows 5** run summary | macOS met; Windows: read the run |
| NFR-05 installers at most 25 MB | `scripts/size-check.mjs` in the **Release** and **Package check** workflows; local `pnpm release:dry-run` (macOS dmg 13 MB) | read the Package check run |
| NFR-07 build and package reproducibly | `docs/releasing.md`, the two workflows | manual |
| NFR-08 network traffic limited to updates, integrations, sync | `scripts/network-audit.mjs` (in the unit tests and in this script) | pass |
| NFR-10 accessibility, NFR-12 localisation | `docs/accessibility.md`: automated audit, keyboard specs, catalog test | automated rows pass; by-ear checks manual |
| Signed, notarized installers | **Changed by decisions D-13 and D-14**: macOS is ad hoc signed and not notarized, Windows installers are unsigned until SignPath approves. Update bundles are signed with the updater key. Sign-off means accepting that the first start needs a right-click, Open on macOS and shows a SmartScreen warning on Windows | decision |
| Auto-update tested from the previous build | see "Update test" below | macOS proven with a throwaway key; real release manual |
| One week of daily use as the main terminal, at least 5 agents a day | the owner | manual |

## Update test

What was proven on 2026-11-12 on macOS, with a debug app bundle of 0.1.0, a signed bundle of 0.1.1 and a local server
(the app reads `TESSERA_UPDATE_ENDPOINT`, `TESSERA_UPDATE_PUBKEY` and `TESSERA_UPDATE_AUTO_INSTALL` in debug builds only):

1. The 0.1.0 app found 0.1.1, downloaded it, verified the signature and replaced its own bundle: `Info.plist` read 0.1.1
   afterwards.
2. The same bundle with one byte appended was refused ("The signature verification failed") and the app stayed 0.1.0.

To repeat it with a real release (needs the private key, so it is yours to run):

1. Install the previous release (for example 0.1.0) and start it once.
2. Publish the next release as a **beta** first: run **Release** with channel `beta`, publish the draft, switch the
   app's Settings, Updates channel to Beta.
3. In Settings, Updates press **Check now**: the new version and its notes appear. Press **Install update**, then
   **Restart now**. About shows the new version, your tasks and terminals are back (the session daemon keeps them).
4. Repeat on Windows (x64, and arm64 if you have one).
5. When it works, publish the same version on stable.

## Windows by-hand checks

See `.agent-lead/windows-human-checklist.md` in the workspace (fonts, high DPI, blur, taskbar visuals, SmartScreen
text) and the by-ear list in `docs/accessibility.md`.
