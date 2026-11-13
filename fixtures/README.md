# Fixtures

Shared test data lives here: terminal samples, sample repositories, fake agent CLIs and hook payloads.
`unicode.txt` exercises grapheme clusters, wide glyphs, combining marks, bidi text, tabs and tables.
Print it with `cat fixtures/unicode.txt` (PowerShell: `Get-Content -Encoding utf8 fixtures/unicode.txt`).
Private-use icons require a Nerd Font; missing glyphs in other fonts are expected.

Add small, deterministic UTF-8 files with descriptive names. Preserve intentional tabs and combining sequences.
Document each fixture here, avoid secrets and personal data, and keep crate-specific parser samples near their tests.
