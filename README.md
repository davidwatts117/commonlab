# CommonLab

Browser-based science simulations for safe, repeatable exploration, served by a Rust **Axum** application. The frontend stays dependency-free HTML/CSS/JavaScript; no frontend build step or login is required.

## Run

Install a current stable Rust toolchain, then run from the repository root:

```sh
cargo run
```

Visit `http://localhost:8000`. Simulation routes such as `/simulations/pendulum` and old bookmarks such as `/simulations/pendulum.html` all use the shared shell. `GET /healthz` returns `ok` for health checks.

### Configuration and deployment

- `BIND_ADDR`: socket address, default `127.0.0.1:8000`. Use `0.0.0.0:8000` to listen on all IPv4 interfaces.
- `PUBLIC_DIR`: asset directory, default `public`, relative to the process working directory. It must contain `index.html`; startup fails otherwise.
- `RUST_LOG`: tracing filter. Use `commonlab=info,tower_http=debug` for request logs.
- `DATABASE_PATH`: SQLite submission database, default `data/commonlab.sqlite3`. Must be outside `PUBLIC_DIR`; use a persistent writable volume in deployment.
- `ADMIN_TOKEN`: securely generated maintainer bearer token (32–256 letters/digits/`-_.`). Without it, new submissions and review actions are disabled.

```sh
cargo build --release --locked
BIND_ADDR=0.0.0.0:8000 PUBLIC_DIR=/path/to/commonlab/public ./target/release/commonlab
```

Deploy the executable **and** the `public/` directory. Assets are read from disk, not embedded. The server handles Ctrl-C and SIGTERM with graceful shutdown. Use a reverse proxy for HTTPS when exposing it publicly.

### Layout

- `src/`: Axum router, configuration, and server startup.
- `public/`: homepage, shared assets, and simulations—the only directory exposed by the server. Asset paths below are relative to this directory.
- `public/simulations/catalog.json`: validated simulation definitions; the homepage and server routes use this catalog.
- `public/simulation.html`, `simulation-ui.mjs`, `simulation.css`: one shared shell and fixed component vocabulary for every simulation.
- `public/simulations/<id>.js`: trusted physics/canvas modules exporting `mount(ui)`, not separate web pages.
- `public/submit.html`, `review.html`: public authoring UI and token-protected maintainer review queue.
- `schema/simulation.schema.json`: compiled-in server definition schema, paired with Rust cross-field validation.
- `data/`: private runtime SQLite database, ignored by Git and never served.
- `tests/`: Rust integration tests, JavaScript unit tests, Playwright browser tests, and a development-only browser smoke page.
- `docs/`: authoring guide and historical implementation plan.

Unknown paths return 404, not the homepage. Source, tests, docs, and Git metadata are not served. CFU answers remain in browser localStorage; there is no account system or results API. SQLite stores simulation submissions, review notes, and publications—not student answers.

Built-in simulations and local definition drafting can still be hosted statically by serving `public/` as the web root. Submission storage/review and community publications require Axum. Deploying to GitHub Pages now requires publishing the contents of `public/`, rather than the repository root.

## Adding simulations

New simulations are **data plus a physics module**, not arbitrary web pages. Anyone can use **`/submit.html`** to build a definition, reuse an installed engine or upload new JavaScript, preview the layout without executing code, and submit a private draft. Maintainers review at **`/review.html`**; approved simulations join the catalog immediately without a restart. New engine code requires explicit trusted review before publication.

To enable the submission workflow locally:

```sh
export ADMIN_TOKEN="$(openssl rand -hex 32)"
cargo run
```

Keep the token secret and enter it in the review UI. Publishing JavaScript grants trusted same-origin application privileges; it is not sandboxed. See [Submission setup, security, and workflow](docs/submissions.md) for limits, deployment precautions, persistence, and APIs.

For repository-authored simulations, add an entry to `public/simulations/catalog.json` and `public/simulations/<id>.js`; no homepage or routing changes are needed. Restart Axum to register the new routes. Controls, readouts, explanations, graphs, lessons, and checks are slotted into the shared shell. Definitions cannot provide HTML, CSS, custom layout trees, or arbitrary module URLs.

See [Simulation authoring](docs/simulation-authoring.md) for the schema, module contract, examples, and verification checklist. All seven existing simulations have been migrated.

## Guided experiments / lessons

The shared engine (`guided.js`) and overlay styles (`guided.css`) are implemented. The Pendulum simulation includes the first pilot lesson, **“What controls a pendulum’s period?”**, with predictions, guided tasks, observation, three practice-only CFU checkpoints, hints, restart/exit, and a completion recap.

### Check Understanding

Pendulum also has a **Check Understanding** launcher in its controls panel. This non-modal self-check keeps the simulation usable and asks five fixed-order questions about length, mass, gravity, and the ideal small-angle period. Single- and multi-choice answers require explicit submission, lock until restart, and show immediate explanations. Finish for a score and full answer review.

- Shared engine/styles: `cfu.js`, `cfu.css`; authored banks are in `simulations/catalog.json`.
- Projectile's four questions now use the same Check Understanding flow, replacing its page-specific quiz.
- Lesson practice and standalone scoring share bank content but keep their answers separate. Opening either mode closes the other.
- Versioned localStorage resumes unfinished standalone checks and retains the latest completed result. Corrupt/unavailable storage is handled safely; there is no backend or cross-device synchronization.
- See [CFU authoring and persistence](docs/guided-experiments-authoring.md#9-shared-check-understanding-cfu-questions) for schema, integration, versioning, and verification.

- [Authoring guide](docs/guided-experiments-authoring.md): current API, integration example, conditions, and verification checklist.
- [Implementation plan](docs/guided-experiments-plan.md): broader design and planned rollout. Some proposed features are not implemented; consult the authoring guide for current behavior.

### Remaining work

- **Expand lesson coverage:** integrate Gas Laws as the second pilot, then author and wire lessons for the other simulations identified in the plan.
- **Extend browser validation:** the Playwright suite covers desktop/mobile shell loading, representative interactions, dialogs, CFU reloads, and guided mounting. Complete the full lesson flows, screen-reader/touch audits, fullscreen/resize validation, visual regression coverage, and performance audit.

Homepage discovery and guided-lesson badges now come directly from the simulation catalog.

The authoring guide is now available. The broader rollout and validation above remain outstanding.

## Tests

Server checks require Rust; frontend tests require Node.js with the built-in test runner:

```sh
cargo fmt --check
cargo clippy --all-targets -- -D warnings
cargo test
node --test tests/*.test.mjs
```

Rust tests cover the homepage, health check, catalog-driven routes, MIME types, HEAD, source/database isolation, private drafts, authentication, explicit code approval, definition/body limits, persistent SQLite publication, rejection/withdrawal, quotas, and pagination. Node tests also validate every catalog entry and its declared module slots.

For automated real-browser checks:

```sh
npm ci
npx playwright install chromium
npm run test:browser
```

Browser tests also cover mobile authoring, inert data/source previews, protected review, publication, engine reuse, withdrawal, and queue locking. Each browser server uses an isolated temporary SQLite database.

Alternatively set `PLAYWRIGHT_CHROMIUM_EXECUTABLE=/path/to/chrome` to use an existing Chromium binary. Node packages are development-only; the frontend still has no bundler or build step.

For real-browser app checks, use `cargo run`. The development-only DOM smoke page is intentionally not served by Axum: run `python -m http.server 8001 --bind 127.0.0.1` from the repository root and open `http://localhost:8001/tests/dom-smoke.html`. Do not use that repository-wide development server for deployment. Automated coverage includes the guided engine, launcher, restart/completion, overlay/dialog behavior, and CFU bank validation, exact-match grading, submit locks/re-entry, persistence/version invalidation, storage failures, full review, and mutual exclusion using a lightweight DOM shim. Screen-reader accessibility, touch, fullscreen, and complete scientific/lesson verification remain manual work.
