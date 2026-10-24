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
