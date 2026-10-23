# Issue #23: separate original and community simulations

The homepage now has distinct **Original simulations** and **Community simulations** groups, accessible headings, and explicit empty states. Existing launch links, subject labels, and lesson badges are preserved.

- Axum adds server-owned `communitySimulationIds` catalog metadata from public submission snapshots. Private drafts never appear; withdrawal removes the community entry. Published variants remain community simulations even when reusing an original engine.
- Browser validation checks provenance IDs without changing the closed submission-definition schema. Static repository catalogs can omit the metadata and continue displaying their entries as originals.
- Regression coverage checks publication/withdrawal, approved snapshots across edits/restarts, malformed provenance, static fallback, grouping independent of catalog order, engine reuse, and desktop/mobile layout.

## Verification

All requested checks passed:
- `cargo fmt --check`
- `cargo clippy --all-targets --locked -- -D warnings`
- `cargo test --locked` — 32 tests
- `npm test` — 48 tests
- `PLAYWRIGHT_CHROMIUM_EXECUTABLE=/usr/bin/google-chrome npm run test:browser` — 24 tests

Rust tools required adding `/home/agent/.cargo/bin` to the command PATH; no repository configuration was changed.

## Browser artifacts

Using the browser skill and a running Axum app with a disposable local database, published a clean installed-engine fixture, checked both groups, launched the community lab, and exercised its length control at desktop and mobile widths. Screenshots contain only public simulation content:
- `catalog-desktop.png` — complete populated catalog with both groups.
- `catalog-mobile.png` — community group and launch card on a narrow viewport.

## Scope and assumptions

“Original” means repository-authored; “community” means a maintainer-published submission, regardless of engine or generation method. Separate groups were chosen rather than adding tabs, new pages, or filters. No database migration is needed. Deploy the updated server and frontend together; static catalogs without provenance are treated as originals. No known outstanding failures.
