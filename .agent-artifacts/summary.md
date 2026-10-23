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
