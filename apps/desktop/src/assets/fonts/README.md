# Terminal fonts

`fonts.css` declares the fonts the terminal uses (03-UI-UX §2, FR-03). The `--font-family-mono` token lists them.

## JetBrains Mono
- Source: the npm package `@fontsource/jetbrains-mono` 5.3.0 (a dependency of `apps/desktop`), weights 400 and 700,
  normal and italic, every subset, woff2. `fonts.css` points at the package's files; nothing is copied here.
- Upstream: https://github.com/JetBrains/JetBrainsMono
- License: SIL Open Font License 1.1 (the `LICENSE` file inside the package).

## Symbols Nerd Font Mono
- File: `SymbolsNerdFontMono-Regular.ttf`, the icon-only Nerd Font, used as a fallback for glyphs JetBrains Mono does
  not have (Powerline, Devicons, Font Awesome and other prompt icons).
- Source: https://github.com/ryanoasis/nerd-fonts/releases/download/v3.5.1/NerdFontsSymbolsOnly.zip
  (release v3.5.1, published 2026-08-21). Zip SHA-256 `fdca3682534f6f65e1ccb2345b0362ccf67d9b8eca7c8025330946e93e2473bc`;
  font SHA-256 `fe471e538392f51910faab985fa8e192a39dd3426125edd15b71b3680df0e749`. Downloaded 2026-11-09.
- License: MIT for the Nerd Fonts project (`LICENSE-SymbolsNerdFontMono.txt`, the `LICENSE` file from the zip). The
  glyphs keep their upstream licenses, listed in the zip's README: Codicons and Font Awesome CC BY 4.0, MaterialDesign
  Apache 2.0, Pomicons and Weather Icons OFL 1.1, Font Logos unlicensed, the rest MIT. Attribution for the CC BY sets
  belongs in the app's About and third-party notices (M12).
