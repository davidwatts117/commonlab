# Issue #24 — Community simulation previews

The homepage only rendered artwork for seven hard-coded built-in IDs, leaving community thumbnails blank. Cards now fall back to trusted physics or chemistry SVG illustrations while preserving existing built-in artwork. Own-property lookup also ensures valid IDs such as `constructor` receive real artwork.

No schema, API, storage, or submission-workflow changes. Previews remain decorative, not engine screenshots: catalog browsing never executes simulation code or accepts contributor image markup. This is the minimal interpretation of the title-only issue; custom image uploads are out of scope. Existing wrapping limitations for unusually long unbroken title tokens are unchanged.

## Regression coverage
- Desktop/mobile community artwork for both subjects and inherited-property IDs.
- Existing built-in artwork, literal hostile titles, visible SVG dimensions, no engine requests, and no horizontal overflow for the fixtures.
- Actual submission → approval → catalog artwork → engine launch → withdrawal flow.

## Verification
All requested checks passed (Rust tools required adding `/home/agent/.cargo/bin` to `PATH`):
# Issue #18 — Design the “My submissions” page

Redesigned the existing private dashboard to match CommonLab’s graph-paper palette and shared site styles, without changing backend APIs or review rules.

- Added responsive submission cards, separate revision/live-status badges, update dates, selected-card styling, and a feedback/history panel.
- Added clear signed-out, first-submission, filtered-empty, loading, and history-error states; retained filters, pagination, edit/live links, and private-content clearing.
- Improved keyboard selection, focus handling, mobile detail navigation, and long-text wrapping. Titles and feedback remain literal text.
- Added browser regression coverage for desktop/mobile layout, empty states, pagination, keyboard selection, live older revisions, literal rendering, errors, and session expiry. Existing end-to-end ownership/privacy tests remain intact.

## Verification
All requested checks pass:
- `cargo fmt --check`
- `cargo clippy --all-targets --locked -- -D warnings`
- `cargo test --locked` — 32 tests
- `npm test` — 47 tests
- `PLAYWRIGHT_CHROMIUM_EXECUTABLE=/usr/bin/google-chrome npm run test:browser` — 24 tests

Also exercised the running server with disposable demo submissions and inspected these actual browser PNG captures:
- `my-submissions-desktop.png` — rejected latest revision, older live revision, feedback and history.
- `my-submissions-mobile.png` — responsive cards and selected detail.
- `my-submissions-empty-mobile.png` — filtered-empty guidance.
- `my-submissions-signed-out.png` — account entry state.

## Scope and caveats
The issue supplied only a title, so the existing homepage design and documented dashboard behavior were used as the reference. No new search, deletion, notifications, backend behavior, or external frontend dependencies were added. Screenshots contain only locally created demo data; the temporary database was removed. Automated keyboard/mobile checks are not a full screen-reader accessibility audit.
# Issue #35 — Gas Laws indicators

## Fix
- The pressure bar was always about 77% full because its maximum was recalculated as `P × 1.3`. It now uses a fixed 0–3000 atm scale, labeled `log(1+P)` with pressure ticks. This keeps changes visible across the built-in controls’ approximately 0.41–2462 atm range; numeric pressure readouts are unchanged.
- Rebuild particles before updating their count, eliminating the one-input delay after changing moles.
- Avoid drawing a negative-height thermometer fill at the minimum temperature.

## Regression coverage and audit
- Four new unit tests cover pressure changes from all three sliders, fixed scale and range endpoints, synchronized readouts/live equation/particle counts, thermometer and particle speed, and piston dragging.
- Browser regression measures actual pressure-bar pixels for volume, temperature and moles changes, including decreasing pressure and immediate particle-count updates.
- Reviewed related built-in indicator/control bindings and exercised the existing cross-simulation browser suite; no additional disconnected indicators were identified. This is representative coverage, not a complete scientific or accessibility audit.
- Confirmed all four new unit tests fail against the original engine and pass with the fix.

## Validation
All requested checks passed (Cargo required adding `/home/agent/.cargo/bin` to `PATH`):
- `cargo fmt --check`
- `cargo clippy --all-targets --locked -- -D warnings`
- `cargo test --locked` — 32 tests passed
- `npm test` — 51 tests passed
- `PLAYWRIGHT_CHROMIUM_EXECUTABLE=/usr/bin/google-chrome npm run test:browser` — 23 tests passed

## Browser evidence
Exercised the running Axum app in headed Chrome: changed moles/temperature, dragged the piston from 5.0 L to 2.5 L, verified pressure/count, and checked the mobile layout without horizontal overflow or page errors. Screenshots show the actual public simulation:
- `gas-laws-default.png` — 7.39 atm, 53 particles
- `gas-laws-high-pressure.png` — 246.17 atm, 525 particles
- `gas-laws-mobile.png` — high-pressure state at phone width

The fixed scale intentionally uses a nonlinear mapping, explicitly labeled on the canvas. If future control ranges exceed 3000 atm, the gauge range should be revisited. No unrelated simulation engines, server behavior, or dependencies changed.
# Issue #20: Contributor account creation discovery

Added visible **Create contributor account** and **Sign in** links to the homepage navigation. The creation link opens `/account.html?action=register` with password confirmation, new-password autocomplete, and the Create account button already enabled for registration. Existing account URLs still default to sign-in; unknown action values also safely fall back to sign-in. The existing Action selector and authenticated-session behavior remain intact.

Updated `docs/contributors.md` and added real-browser regression coverage for desktop/mobile discovery, registration defaults, switching modes, unknown actions, existing sessions, and registration/logout/sign-in through the homepage links. The new discovery test failed before the fix because the homepage link was missing.

## Validation

All requested checks passed:
- `cargo fmt --check`
- `cargo clippy --all-targets --locked -- -D warnings`
- `cargo test --locked` — 32 tests passed
- `npm test` — 47 tests passed
- `PLAYWRIGHT_CHROMIUM_EXECUTABLE=/usr/bin/google-chrome npm run test:browser` — 24 tests passed
- `git diff --check`

Browser-skill verification additionally published two synthetic community examples against an isolated temporary Axum/SQLite instance, inspected desktop/mobile rendering, and launched the published simulation successfully. No real accounts or private data were used. Representative actual-app screenshots:
- `community-previews-desktop.png`
- `community-previews-mobile.png`

Rust tools required adding `/home/agent/.cargo/bin` to PATH in this environment. Also exercised the running app in headed Chromium at desktop and phone sizes, checked for horizontal overflow, and inspected these actual screenshots (empty account fields; no credentials/private data):
- [Desktop homepage](homepage-account-desktop.png)
- [Mobile homepage](homepage-account-mobile.png)
- [Mobile registration reached from the homepage](registration-mobile.png)

## Scope and caveats

The title-only issue was interpreted as a discoverability problem, not a request to redesign authentication. Changes are limited to navigation, initial form mode, documentation, and tests; account APIs, permissions, password rules, and submission behavior are unchanged. Browsing simulations still requires no account. No blocking ambiguities were found.
