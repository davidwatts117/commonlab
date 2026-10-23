# Issue #17 — circuit wire placement and connections

Fixed wire drawing on an empty board and connections between wires.

- `public/simulations/circuits.js`: construct the finished component from the saved drag state instead of reading cleared state; let the Wire tool start branches on existing wires; snap endpoints onto wire interiors before the existing junction-splitting step. Select-tool movement is preserved, and the wire hint describes the behavior.
- `tests/browser/simulations.test.mjs`: desktop/phone-sized regression coverage for free-space drawing, endpoint connections, slightly off-wire junction snapping, dragged parts, click placement, and Select-tool movement. Electrical assertions verify an open circuit, a closed 100-ohm circuit, and a second parallel branch. The regression failed on the original code.

## Validation

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
