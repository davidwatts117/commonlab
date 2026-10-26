# Merge preparation — 2026-10-25

Merged `origin/main` into the math-rendering branch, preserving both artifact histories and all independent math, wide-layout, certificate, and circuit browser regressions. Retained the worker startup fix that allowlists the local math modules, stylesheet, and font in the verification sandbox.

Validation of the combined tree:
- `cargo fmt --check` and `cargo clippy --all-targets --locked -- -D warnings` passed.
- `cargo test --locked`: 34 passed.
- `npm test`: 77 passed.
- `npm run test:browser`: 37 passed, including suite parents.
- `PLAYWRIGHT_BROWSERS_PATH="$HOME/.cache/ms-playwright" CL_TEST_BROWSER=1 npm --prefix worker test`: 76 passed; the read-only-image-only test was skipped locally.
- An isolated read-only worker container with the merged public assets passed all 18 verification, supervisor, and storage tests, including the missing-checkpoint-mount case.
- `git diff --check` passed. The initial host worker-browser run needed the explicit browser-cache path because verification sets `HOME=/tmp`; the corrected invocation passed without code changes.

Historical implementation summaries and evidence follow unchanged.

---

# Issue #38 — Math and formulas render correctly

## Fix
- Added locally vendored Temml 0.14.0 (MIT) to render delimited LaTeX as semantic MathML in shared explanation cards and information dialogs, including authoring/review previews.
- Converted the built-in gas-law, pendulum, circuit and projectile equations to LaTeX, including proper fractions, roots, subscripts and superscripts. Corrected the gas-constant unit notation.
- Added authoring guidance and a rendered default formula. Existing unmarked prose/formulas and single-dollar currency remain literal; use `\(...\)` inline or `$$...$$` / `\[...\]` for display equations.
- Disabled trusted commands (including links/images), bounded expansion/dimensions, and retained literal source on invalid math. Wide equations scroll inside their containers rather than overflowing mobile pages. No CDN or build step is needed.

## Verification
All requested checks passed:
- `cargo fmt --check`
- `cargo clippy --all-targets --locked -- -D warnings`
- `cargo test --locked` — 34 tests passed
- `npm test` — 62 tests passed
- `PLAYWRIGHT_CHROMIUM_EXECUTABLE=/usr/bin/google-chrome npm run test:browser` — 33 tests passed

Regression tests cover semantic equation structure, built-in formulas/dialogs, namespaced inert previews, literal HTML/currency, malformed and unsafe expressions, bounded macros, macro isolation, mobile overflow, and dialog focus restoration. Rust commands required adding the installed `/home/agent/.cargo/bin` to PATH.

Exercised the running app in headed Chromium using the browser skill: inspected desktop/mobile gas-law formulas, opened/closed Charles's-law help, changed temperature (readout became 400 K), and edited/rendered an equation through the visual authoring UI. No page errors occurred. Representative PNGs:
- `math-gas-laws-desktop.png`
- `math-gas-laws-mobile.png`
- `math-gas-laws-dialog.png`
- `math-authoring-preview-mobile.png`

## Scope and caveats
Issue description reviewed: pati08 (COLLABORATOR), created/updated 2026-10-24 16:04:33 UTC. GitHub confirmed there are no comments or maintainer clarifications. No repository AGENTS.md was present.

Rendering is deliberately opt-in via delimiters so prose-like formulas and existing submissions are not reinterpreted. Canvas labels, live numeric readouts, and assessment text are unchanged. Native MathML requires a modern browser; full assistive-technology and cross-browser audits were not performed. No physics, authentication, persistence or server behavior changed.

---

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
Screenshots use only the public homepage and an isolated temporary database. Email delivery and external mail-client behavior were not tested; the exact `mailto:` destination is verified without sending email. No blocking ambiguities.

# PR #26 feedback follow-up

## Feedback addressed

Addressed pati08's [comment 6389316398](https://github.com/davidwatts117/commonlab/pull/26#issuecomment-6389316398): the exploration indicator previously appeared merely by loading the page; add time spent. Read the supplied PR description and full conversation; there were no review summaries or inline comments. No `AGENTS.md` was present in the worktree or ancestor directories.

## Changes

- `public/completion-certificate.mjs`: exploration now explicitly says **not recorded** until a trusted interaction with a simulation control or canvas. Certificate form entry, synthetic engine events, guided navigation, and assessment controls do not trigger it.
- Add local minutes/seconds spent exploring, measured with a monotonic clock. Count visible time following interaction, cap each idle interval at 60 seconds, and suspend on hidden tabs/pagehide (including Back/Forward cache). Another simulation interaction resumes counting. Remove listeners on teardown.
- `public/simulation-page.mjs`: pass the simulation root to scope interaction tracking.
- `README.md` and certificate copy explain the estimate, idle cutoff, visit-only lifetime, and regeneration to update the snapshot. Names/time are not persisted or sent anywhere. Existing guided/assessment behavior and print/PDF support are preserved.
- Regression coverage in `tests/completion-certificate.test.mjs` and `tests/browser/simulations.test.mjs`: no automatic credit, trusted keyboard/canvas activity, ignored synthetic and learning events, timing/idle limits, hidden tabs, bfcache suspension, cleanup, reload reset, privacy, mobile layout, and single-page PDF output. Existing assertions retained and updated only for the changed exploration wording.

## Validation

All requested checks passed on the final code:

- `cargo fmt --check`
- `cargo clippy --all-targets --locked -- -D warnings`
- `cargo test --locked` (32 tests)
- `npm test` (53 tests)
- `PLAYWRIGHT_CHROMIUM_EXECUTABLE=/usr/bin/google-chrome npm run test:browser` (25 tests including suite parents)
- `git diff --check`

Initial Rust/browser invocations could not locate Cargo; reran successfully after adding `/home/agent/.cargo/bin` to `PATH`.

## Visual evidence

Actual local Axum app screenshots from Chromium, using only the fictitious name “Sample Student” and an isolated temporary database:

- `desktop-no-interaction.png`: explicit unrecorded exploration state.
- `desktop-print-exploration.png`: print rendering with interaction-gated time spent.
- `mobile-exploration.png`: 390px-wide Gas Laws certificate after a touchscreen canvas interaction.

## Unaddressed items / caveats

No supplied feedback was left unaddressed. Time is an estimate, not evidence of attention or mastery; the disclosed 60-second idle cap can undercount passive observation. No arbitrary minimum study duration or certificate eligibility gate was introduced, since the feedback requested interaction and time reporting, not a new qualification policy. Reload resets tracking; already generated certificates remain snapshots until regenerated.

No commits, pushes, branch/remote changes, or PR/review actions were performed. Files and artifacts are left for controller publication on the existing feature branch.

---

# Latest follow-up: distinguish description from participation

## Feedback addressed

Addressed pati08's latest [comment 6390039011](https://github.com/davidwatts117/commonlab/pull/26#issuecomment-6390039011), requesting a clearer divide between the simulation/activity description and the list of things the student did.

Read the supplied PR description and entire conversation; no review summaries or inline comments were supplied. Inspected the existing PR diff, implementation, and tests. No `AGENTS.md` exists in the worktree or ancestor directories. No blocking clarification was needed.

## Focused changes

- `public/completion-certificate.mjs`: separate named sections and headings for **About this simulation** (title and description) and **Recorded participation** (existing activity list). Remove the now-unnecessary connecting phrase “For engaging in”. Render all content as literal text, as before.
- `public/completion-certificate.css`: left-align section content, add spacing and a solid divider above the participation record. The divider remains visible in monochrome print/PDF without relying on background graphics. Keep the centered certificate header, recipient, and footer.
- `public/simulation.html`: bump the certificate stylesheet version.
- Regression tests in `tests/completion-certificate.test.mjs` verify section labels, headings, content separation/order, and regeneration without duplicate sections. Browser assertions verify accessible sections, actual spacing/divider on desktop, mobile, and print, while retaining the existing single-page A4 PDF, privacy, timing, and activity assertions. No existing tests were weakened.

## Validation

All requested checks passed on the final code, with `/home/agent/.cargo/bin` added to `PATH`:

- `cargo fmt --check`
- `cargo clippy --all-targets --locked -- -D warnings`
- `cargo test --locked` (32 tests)
- `npm test` (54 tests)
- `PLAYWRIGHT_CHROMIUM_EXECUTABLE=/usr/bin/google-chrome npm run test:browser` (25 tests including suite parents)
- `git diff --check`

The first unit-test run exposed a limitation of the existing DOM shim: tag selectors do not handle digits in heading names. The new test now locates headings by their actual `tagName`; real-browser tests independently verify heading roles and levels. The shared shim and existing assertions were not changed.

## Current visual evidence

Captured and inspected actual local Axum app PNGs in Chromium, using an isolated temporary database and only the fictitious name “Sample Student”:

- `certificate-sections-desktop.png`: Pendulum description clearly separated from exploration, completed guided activity, and an in-progress check.
- `certificate-sections-print.png`: the same certificate under print media, with the divider intact.
- `certificate-sections-mobile.png`: Gas Laws free-exploration certificate at a 390px phone viewport after a touchscreen interaction.

The earlier screenshots and summary above are preserved as historical evidence from the prior follow-up; the `certificate-sections-*.png` files show the current layout.

## Unaddressed items / caveats

No supplied feedback is left unaddressed. The earlier [comment 6389316398](https://github.com/davidwatts117/commonlab/pull/26#issuecomment-6389316398) and follow-up [6389465065](https://github.com/davidwatts117/commonlab/pull/26#issuecomment-6389465065) are already reflected in the existing interaction-gated exploration/time implementation; no redundant tracking changes or new eligibility policy were introduced. Existing estimate, idle-cap, snapshot, reload, guided, and assessment behavior remains unchanged.

No commits, pushes, branch/remote changes, or PR/review actions were performed. Changes and artifacts remain in the worktree for controller publication on the existing feature branch.

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
