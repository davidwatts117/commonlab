# Issue #24 — Community simulation previews

The homepage only rendered artwork for seven hard-coded built-in IDs, leaving community thumbnails blank. Cards now fall back to trusted physics or chemistry SVG illustrations while preserving existing built-in artwork. Own-property lookup also ensures valid IDs such as `constructor` receive real artwork.

No schema, API, storage, or submission-workflow changes. Previews remain decorative, not engine screenshots: catalog browsing never executes simulation code or accepts contributor image markup. This is the minimal interpretation of the title-only issue; custom image uploads are out of scope. Existing wrapping limitations for unusually long unbroken title tokens are unchanged.

## Regression coverage
- Desktop/mobile community artwork for both subjects and inherited-property IDs.
- Existing built-in artwork, literal hostile titles, visible SVG dimensions, no engine requests, and no horizontal overflow for the fixtures.
- Actual submission → approval → catalog artwork → engine launch → withdrawal flow.

## Verification
All requested checks passed (Rust tools required adding `/home/agent/.cargo/bin` to `PATH`):
- `cargo fmt --check`
- `cargo clippy --all-targets --locked -- -D warnings`
- `cargo test --locked` — 32 tests passed
- `npm test` — 47 tests passed
- `PLAYWRIGHT_CHROMIUM_EXECUTABLE=/usr/bin/google-chrome npm run test:browser` — 24 tests passed
- `git diff --check`

Browser-skill verification additionally published two synthetic community examples against an isolated temporary Axum/SQLite instance, inspected desktop/mobile rendering, and launched the published simulation successfully. No real accounts or private data were used. Representative actual-app screenshots:
- `community-previews-desktop.png`
- `community-previews-mobile.png`
