# Bundled terminal themes

`iterm2-schemes.json` holds 907 colour schemes from **mbadolato/iTerm2-Color-Schemes**
(https://github.com/mbadolato/iTerm2-Color-Schemes), MIT licence (copy in `LICENSE-iTerm2-Color-Schemes.txt`; the
licence covers the collection, the copyright of each scheme belongs to its author, see the repository's `CREDITS.md`).

- Source commit: `bc5531d8ec26e6031c698c61eb7d82c9a9cd092d` (2026-11-09).
- Read from the repository's `windowsterminal/*.json` files (one scheme each, the same colours as the iTerm2 originals).
- Format: `[name, background, foreground, cursor, selection, [16 ANSI colours]]`, colours as 6 hex digits without `#`.
  907 schemes, 181 KB raw, 68 KB gzipped. Loaded on demand (dynamic import), never in the main bundle.
- Regenerate: clone the repository (`git clone --depth 1 --filter=blob:none --sparse …` and
  `git sparse-checkout set windowsterminal`), then `node apps/desktop/src/themes/generate.mjs <checkout>`.

Imported themes (`.itermcolors`, Ghostty, Windows Terminal JSON) are parsed by `parsers.ts` and kept app-local in
`localStorage` (`tessera.importedThemes`) until the Rust side has a themes folder (`themes_list` / `theme_import`).
