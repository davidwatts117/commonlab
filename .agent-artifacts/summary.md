# Issue #16: Text occasionally leaks outside of boxes

Fixed reproduced overflow in the shared simulation controls: Build a Nucleus's “Carbon” value crossed a readout border at 390px, and neutron button labels crossed their borders at 320px.

- Increased the shared readout grid's minimum cell width from 90px to 120px, allowing a single cell to shrink for narrower containers.
- Allowed readout content and simulation button labels to wrap rather than overflow or be clipped. No text or functionality was removed.
- Added browser regression coverage measuring actual text rectangles against readout/button borders, before and after changing Carbon to Nitrogen, at 320, 390, 900 and 1280px. Page overflow and JavaScript errors are checked too.

## Verification

All requested checks passed:

- `cargo fmt --check`
- `cargo clippy --all-targets --locked -- -D warnings`
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
