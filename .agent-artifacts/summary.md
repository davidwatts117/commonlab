# Issue #2 — Finish circuits

Implemented the circuit-editor improvements listed by pati08 (COLLABORATOR, comment created/updated 2026-10-25T00:24:49Z). The issue description is empty; the supplied thread contains one comment and no conflicting clarifications.

## Changes
- Added Undo for placement, movement/reconnection, numeric edits, switches, deletion, clearing and presets. An eraser stroke is one undoable action; Ctrl/Cmd+Z is canvas-scoped.
- Fixed-size parts can replace a span of existing wire without leaving an electrical bypass. Toolbox drops follow the wire direction and preserve its outer connections.
- New fixed-size placement snaps to 15° increments, hides projections near the root, and shows root/target markers. Previews no longer allocate component IDs.
- Wires support dragging or two clicks, with Escape/tool-switch cancellation. Erasing sweeps between pointer events.
- Value labels avoid components and each other, with opaque backing and leader lines. Numeric editor labels visibly show V or Ω. Updated in-app instructions.
- Changes are limited to the circuit module/catalog entry, regression tests and these artifacts; no dependencies or solver changes.

## Verification
All requested checks passed (Rust tools required `/home/agent/.cargo/bin` on PATH):
- `cargo fmt --check`
- `cargo clippy --all-targets --locked -- -D warnings`
- `cargo test --locked` — 34 tests
- `npm test` — 64 tests, including seven new circuit regressions
- `PLAYWRIGHT_CHROMIUM_EXECUTABLE=/usr/bin/google-chrome npm run test:browser` — 31 tests
- `git diff --check`

Regressions cover two-click wires/cancellation, angle and length constraints, preview stability, insertion topology and solved current, diagonal/toolbox insertion, swept erasing, undo coverage, visible units and label geometry. Existing desktop/phone circuit tests retain open/closed/parallel electrical checks and now exercise insertion, erasing, numeric edits and keyboard undo.

## Browser evidence
Used the browser skill with the running Axum app, an isolated temporary database and headed Chrome. Insertion changed the displayed series current from 0.29 A to 0.07 A; Undo restored 0.29 A. Actual public-app PNGs:
- [Insertion, labels and units](circuits-insertion-values.png)
- [15° preview and root/target markers](circuits-angle-preview.png)
- [Pending two-click wire](circuits-two-click-wire.png)
- [Phone layout after insertion](circuits-mobile-insertion.png)

## Defaults and caveats
Undo retains up to 100 edits in memory for this page session; redo/persistence were not requested. Insertion requires enough room within one uninterrupted wire segment; existing wire angles take precedence over 15° snapping when inserting. Extremely crowded labels are omitted rather than obscuring circuitry. Phone-size automation uses pointer input, not a comprehensive physical-touch or accessibility audit. No known failing checks.
