# Issue #15: simulations when leaving a tab

Fixed the shared animation loop: returning from a background tab no longer sends the whole elapsed absence into physics, which could destabilize the pendulum or skip simulation events.

## Changes
- Suspend animation/physics/guided ticks while the document is hidden; resume existing state with a fresh timestamp, preserving user Pause settings.
- Cap visible frame gaps at 50 ms before speed scaling, discarding missed time rather than catching up.
- Cancel pending frames on stop and prevent duplicate loops across stop/start, reset, and visibility changes. Remove visibility listeners on stop.
- Update lifecycle documentation and the shell's library cache version. No per-engine physics or layout changes.

## Verification
All requested checks passed:
- `cargo fmt --check`
- `cargo clippy --all-targets --locked -- -D warnings`
- `cargo test --locked` — 32 tests passed.
- `npm test` — 52 tests passed, including five new lifecycle regressions (all failed before the fix).
- `PLAYWRIGHT_CHROMIUM_EXECUTABLE=/usr/bin/google-chrome npm run test:browser` — 24 tests passed, including a new pendulum hidden-minute/resume/pause regression.

Used the installed Rust tools by adding `/home/agent/.cargo/bin` to PATH.

## Browser evidence and caveats
Exercised the running Axum app in headed Chrome with a real 60-second wait, checked unchanged hidden state, stable resume, and preserved Pause/Resume behavior, with no page errors. Screenshot: [pendulum after visibility resume](pendulum-after-visibility-resume.png).

Chrome automation kept native background tabs marked visible, so both browser verification paths explicitly dispatched visibility signals; the automated regression uses a controlled clock. The PNG captures the actual running pendulum and graphs after resuming, not a mock rendering.

The issue has no body. Assumed educational simulations should preserve their state while hidden, not catch up to wall-clock time. Very slow visible rendering intentionally slows simulated time to keep steps bounded; this is not a fixed-timestep physics rewrite.

# Issue #17 — circuit wire placement and connections

Fixed wire drawing on an empty board and connections between wires.

- `public/simulations/circuits.js`: construct the finished component from the saved drag state instead of reading cleared state; let the Wire tool start branches on existing wires; snap endpoints onto wire interiors before the existing junction-splitting step. Select-tool movement is preserved, and the wire hint describes the behavior.
- `tests/browser/simulations.test.mjs`: desktop/phone-sized regression coverage for free-space drawing, endpoint connections, slightly off-wire junction snapping, dragged parts, click placement, and Select-tool movement. Electrical assertions verify an open circuit, a closed 100-ohm circuit, and a second parallel branch. The regression failed on the original code.

## Validation
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

# Issue #16: Text occasionally leaks outside of boxes

Fixed reproduced overflow in the shared simulation controls: Build a Nucleus's “Carbon” value crossed a readout border at 390px, and neutron button labels crossed their borders at 320px.

- Increased the shared readout grid's minimum cell width from 90px to 120px, allowing a single cell to shrink for narrower containers.
- Allowed readout content and simulation button labels to wrap rather than overflow or be clipped. No text or functionality was removed.
- Added browser regression coverage measuring actual text rectangles against readout/button borders, before and after changing Carbon to Nitrogen, at 320, 390, 900 and 1280px. Page overflow and JavaScript errors are checked too.

## Verification

All requested checks passed:

- `cargo fmt --check`
- `cargo clippy --all-targets --locked -- -D warnings`
- `cargo test --locked` — 32 passed
- `npm test` — 47 passed
- `PLAYWRIGHT_CHROMIUM_EXECUTABLE=/usr/bin/google-chrome npm run test:browser` — 24 passed

Rust commands used `/home/agent/.cargo/bin` on PATH. No dependency changes were needed.

## Browser evidence

Actual Chromium captures of the running, unmodified app using an isolated temporary database:

- `circuit-wire-open-space.png`: standalone wire drawn on an empty board.
- `circuit-wire-junctions.png`: wire-to-wire connections and two mid-wire junctions; the parallel circuit carries 0.18 A.

Scope/assumptions: connections remain endpoint-based, including endpoints placed on wire interiors; mere interior crossings do not create junctions. Phone-size tests exercise pointer interactions, not a comprehensive physical-touch/accessibility audit. No known remaining blockers for this issue.
- `cargo test --locked`
- `npm test` (47 tests)
- `PLAYWRIGHT_CHROMIUM_EXECUTABLE=/usr/bin/google-chrome npm run test:browser` (24 tests)

Rust required adding `/home/agent/.cargo/bin` to this shell's PATH. Original CSS was separately replayed in Chromium to confirm the text-border crossings.

## Screenshots

Captured from the running local Axum app with Chromium/Playwright:

- `nucleus-mobile.png`: corrected Carbon readout grid at 390px.
- `nucleus-narrow.png`: corrected Nitrogen readouts and wrapped stepper labels at 320px, after clicking the proton control.

## Scope and caveats

The issue has a title only; scope is the reproduced readout and button overflow, fixed through shared styles rather than simulation-specific exceptions. At very narrow widths, labels may break within words and readouts use fewer columns to keep all text visible. Nuclear-data requests were blocked during browser verification to use the existing deterministic offline fallback. Canvas-rendered text and unrelated layout changes are outside this focused fix.
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

# Issue #19 — Official contact address

Updated the homepage footer’s displayed email and `mailto:` destination from `hello@commonlab.org` to **support@common-lab.org**. Repository search found no other public contact email requiring replacement; no unrelated behavior changed.

Added desktop/mobile browser regression coverage for Contact navigation, the exact email text and destination, visibility, and absence of horizontal overflow. Confirmed the regression fails against the original address and passes after the fix.

## Validation
All requested checks passed:
- `cargo fmt --check`
- `cargo clippy --all-targets --locked -- -D warnings`
- `cargo test --locked` — 32 tests
- `npm test` — 51 tests
- `PLAYWRIGHT_CHROMIUM_EXECUTABLE=/usr/bin/google-chrome npm run test:browser` — 27 tests
- `git diff --check`

Cargo required adding `/home/agent/.cargo/bin` to `PATH`. Exercised the running Axum app using the browser skill with Chrome at desktop/mobile widths; inspected actual footer screenshots:
- [Desktop contact](contact-desktop.png)
- [Mobile contact](contact-mobile.png)

Screenshots use only the public homepage and an isolated temporary database. Email delivery and external mail-client behavior were not tested; the exact `mailto:` destination is verified without sending email. No blocking ambiguities.

# Issue #39 — Smooth landing-page graph

Replaced the hero illustration’s coarse straight-line polyline with a static cubic Bézier path. Matching endpoint tangents remove visible corners while preserving the damped oscillation, graph extent, color, stroke weight, axes, labels, and responsive layout. No JavaScript, dependencies, or simulation-engine changes were needed. An inline comment documents the curve formula and sampling.

## Regression coverage
- Added a unit test for continuous cubic geometry, matching tangents, increasing time, original endpoints, styling, and agreement with the original damped-cosine shape. Confirmed it fails before the fix.
- Added desktop/mobile Chrome coverage checking rendered bounds, curve length, no segmented polyline, and no horizontal overflow, with JavaScript disabled.

## Verification
All requested checks passed:
- `cargo fmt --check`
- `cargo clippy --all-targets --locked -- -D warnings`
- `cargo test --locked` — 34 tests passed.
- `npm test` — 58 tests passed.
- `PLAYWRIGHT_CHROMIUM_EXECUTABLE=/usr/bin/google-chrome npm run test:browser` — 32 tests passed.
- `git diff --check`

Cargo required adding `/home/agent/.cargo/bin` to this shell’s PATH; repository configuration is unchanged.

## Browser evidence and scope
Used the browser skill with the running Axum app, a disposable local database, and headed Chrome at 1280px and 390px widths. Inspected actual rendered PNGs, verified Explore simulations navigation, and observed no JavaScript page errors:
- [Desktop hero and graph](landing-graph-desktop.png)
- [Mobile illustration and graph](landing-graph-mobile.png)

The supplied issue has an empty description and no comments or author/timestamp metadata. Interpreted the title as referring to the landing hero’s visibly segmented oscillation, not the intentionally dashed pendulum construction lines or interactive simulation graphs. Screenshots contain only public homepage content. Visual verification was limited to Chrome; no known outstanding failures.
