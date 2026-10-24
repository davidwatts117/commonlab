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

Rust tools required adding `/home/agent/.cargo/bin` to PATH in this environment. Also exercised the running app in headed Chromium at desktop and phone sizes, checked for horizontal overflow, and inspected these actual screenshots (empty account fields; no credentials/private data):
- [Desktop homepage](homepage-account-desktop.png)
- [Mobile homepage](homepage-account-mobile.png)
- [Mobile registration reached from the homepage](registration-mobile.png)

## Scope and caveats

The title-only issue was interpreted as a discoverability problem, not a request to redesign authentication. Changes are limited to navigation, initial form mode, documentation, and tests; account APIs, permissions, password rules, and submission behavior are unchanged. Browsing simulations still requires no account. No blocking ambiguities were found.
