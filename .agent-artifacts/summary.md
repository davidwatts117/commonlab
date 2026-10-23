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
