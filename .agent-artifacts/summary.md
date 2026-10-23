# Issue #13 — Use horizontal room better

Implemented the clarified scope: shared simulation pages only, rearranging graphs and explanations to reduce scrolling rather than merely enlarging the canvas.

## Changes
- Live workspaces use the available page width with existing gutters.
- From 1280px, graphs sit beside the scene; controls occupy a readable 420px column with compact spacing.
- From 1800px, explanations start beside the workspace; from 2200px, reference cards use two columns.
- Empty graph/reference columns are omitted. Narrow-screen reading order, fullscreen views, component bindings, and the sticky action dock are preserved. Authoring previews do not adopt the new wide-page columns.
- Documented the responsive layout in `docs/simulation-authoring.md`.

## Validation
All requested checks passed:
- `cargo fmt --check`
- `cargo clippy --all-targets --locked -- -D warnings`
- `cargo test --locked` — 32 tests
- `npm test` — 48 tests
- `PLAYWRIGHT_CHROMIUM_EXECUTABLE=/usr/bin/google-chrome npm run test:browser` — 25 tests

Used the existing Rust installation via `$HOME/.cargo/bin` on PATH. Added regression tests for graph grouping/slot order and all seven simulations across eleven viewport widths (390–2560px), including breakpoint boundaries, overflow, canvas proportions, dock sizing, reference columns, interactions, and fullscreen tabs. Confirmed the baseline layout fails the new side-by-side placement expectations by serving the original assets through browser request interception. No existing tests were weakened.

Exercised the running Axum app with Playwright: resizing, changing pendulum length, submitting a self-check, and holding the titration tap to populate its readings log. Inspected these actual-app PNG captures:
- `pendulum-wide.png` — 1920px, scene/graphs/controls/explanations alongside.
- `pendulum-phone.png` — 390px, stacked layout without horizontal overflow.
- `titration-wide.png` — 2560px, two-column references and working readings log/dock.

## Caveats
Breakpoints are conservative readability defaults. Long controls/reference content can still require vertical scrolling, especially below the wide-layout thresholds. Browser validation used Chromium, not a cross-browser or screen-reader audit. No simulation physics, schemas, backend behavior, or unrelated page layouts were changed.
