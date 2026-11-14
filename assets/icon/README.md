# Tessera app icon

`tessera.svg` is the master (1024 × 1024, macOS-style margin). `tessera-1024.png` is its raster export.

Idea: a tessera is one tile of a mosaic. Nine rounded tiles form a grid like a split terminal; five of them light up
as a **T**. The last tile of the stem is white and glows: the cursor, or the agent that wants you.
Dark squircle, baby blue tiles (D-18) (the `--accent` family in `packages/ui/src/tokens.css`), soft bloom, glass edge.

Regenerate every platform size after editing the SVG:

```sh
node scripts/icon.mjs      # re-exports tessera-1024.png from the SVG (needs the Playwright Chromium install)
pnpm --filter @tessera/desktop tauri icon ../../assets/icon/tessera-1024.png
rm -rf apps/desktop/src-tauri/icons/android apps/desktop/src-tauri/icons/ios   # not targeted
```
