# CommonLab

Browser-based science simulations for safe, repeatable exploration, served by a Rust **Axum** application. The frontend stays dependency-free HTML/CSS/JavaScript; no frontend build step or login is required.

## Run

Install a current stable Rust toolchain, then run from the repository root:

```sh
cargo run
```

Visit `http://localhost:8000`. Simulation routes such as `/simulations/pendulum` and old bookmarks such as `/simulations/pendulum.html` all use the shared shell. `GET /healthz` returns `ok` for health checks.

### Configuration and deployment

For the complete Docker setup—including HTTPS, persistent storage, the optional AI worker, backups, updates, and troubleshooting—see the [deployment guide](docs/deployment.md).

- `BIND_ADDR`: socket address, default `127.0.0.1:8000`. Use `0.0.0.0:8000` to listen on all IPv4 interfaces.
- `PUBLIC_DIR`: asset directory, default `public`, relative to the process working directory. It must contain `index.html`; startup fails otherwise.
- `RUST_LOG`: tracing filter. Use `commonlab=info,tower_http=debug` for request logs.
- `DATABASE_PATH`: SQLite submission database, default `data/commonlab.sqlite3`. Must be outside `PUBLIC_DIR`; use a persistent writable volume in deployment.
- `COOKIE_SECURE`: enables Secure, host-only contributor session cookies. Defaults to true on non-loopback binds and false on loopback; use HTTPS and `COOKIE_SECURE=true` publicly.
- `ADMIN_TOKEN`: securely generated maintainer bearer token (32–256 letters/digits/`-_.`). Without it, new submissions and review actions are disabled.

```sh
cargo build --release --locked
BIND_ADDR=0.0.0.0:8000 PUBLIC_DIR=/path/to/commonlab/public ./target/release/commonlab
```

Deploy the executable **and** the `public/` directory. Assets are read from disk, not embedded. The server handles Ctrl-C and SIGTERM with graceful shutdown. Use a reverse proxy for HTTPS when exposing it publicly.

### Docker

The root `Dockerfile` builds a two-stage image: it compiles the release binary on `rust:1.97-slim-trixie`, then copies the binary and `public/` into `debian:trixie-slim`. The image runs as UID 10001, keeps assets root-owned and read-only, and stores SQLite in the `/data` volume (`DATABASE_PATH=/data/commonlab.sqlite3`). It listens on `0.0.0.0:8000` and has a health check that probes `/healthz`. The build context is allowlisted in `.dockerignore` (`Cargo.*`, `src/`, `schema/`, `public/`), so local databases, `.git`, `target/` and secrets never reach it.

```sh
docker compose up --build -d          # http://localhost:8000, data in the commonlab-data volume
docker compose logs -f app
docker compose down                   # add -v only if you mean to delete the database
```

`compose.yaml` publishes on loopback only (`COMMONLAB_PORT` changes the host port). It runs with a read-only root filesystem, dropped capabilities and no-new-privileges. `ADMIN_TOKEN`, `GENERATION_WORKER_TOKEN`, `COOKIE_SECURE` and `RUST_LOG` pass through only when they're set in your shell or a root `.env` file (ignored by Git). Leave unused ones unset rather than empty, because an empty token fails startup validation. Because the container binds a non-loopback address, session cookies default to Secure. Chrome and Firefox accept that on `http://localhost`. For plain-HTTP access from another host, or in Safari, set `COOKIE_SECURE=false` for testing only.

Run the offline recovery command against the same volume with the server stopped:

```sh
docker compose stop app
docker compose run --rm app withdraw <submission-id> "<note>"
```

Without compose, the equivalent is `docker build -t commonlab .` and then `docker run -p 127.0.0.1:8000:8000 -v commonlab-data:/data commonlab`. `.github/workflows/docker.yml` builds the image on every push and pull request to `main`. It starts the image with the same hardening, waits for the health check, and smoke-tests the homepage, catalog, a simulation route, account registration, and that the database is never served. It also checks that the generation worker image (`worker/Dockerfile`, see [AI generation](docs/ai-generation.md)) still builds. Images are built and tested in CI but not published to a registry.

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

Unknown paths return 404, not the homepage. Source, tests, docs, and Git metadata are not served. CFU answers remain in browser localStorage; there is no student-results API. Contributor accounts are separate from student assessment progress. SQLite stores contributor accounts/password hashes, expiring session digests, submission revisions, review history, and approved publication snapshots—not student answers.

Built-in simulations and local definition drafting can still be hosted statically by serving `public/` as the web root. Submission storage/review and community publications require Axum. Deploying to GitHub Pages now requires publishing the contents of `public/`, rather than the repository root.

## Adding simulations

New simulations are **data plus a physics module**, not arbitrary web pages. Anyone can use **`/submit.html`** to build a definition, reuse an installed engine or upload new JavaScript, and preview the layout without executing code. Sign in or register at **`/account.html`** to submit a private draft owned by your contributor account. Visit **`/contributions.html`** to track statuses, read maintainer feedback/history, and edit/resubmit your saved work. Edits stay private until reapproved; any older published revision remains unchanged. See [Contributor accounts](docs/contributors.md) for account/editing APIs, database/session security and deployment settings. Maintainers review at **`/review.html`**; approved simulations join the catalog immediately without a restart. New engine code requires explicit trusted review before publication.

The authoring page includes **visual explanation-card and question-bank editors** (single/multiple answers, explanations, lesson/check usage, ordering). Advanced control/lesson configuration remains available as JSON. Download a **complete submission bundle** to save the definition, engine choice/code, and submitter name, then restore it later without running its code. Unsubmitted local drafts are not automatically stored on shared browsers. Submitted drafts and saved revisions persist privately in SQLite under their owner's account.

**AI-assisted authoring:** maintainers can explicitly approve contributor accounts for `/generate.html`. A separate, isolated worker uses a pinned pi SDK, operator-selected model, fixed prompt, dedicated reference/validation/finalization tools, and bounded jobs. Results open as private inert drafts for editing and explicit submission—not automatic publication. Generation is disabled by default; see [AI generation setup, limits and safety](docs/ai-generation.md).

To enable the submission workflow locally:

```sh
export ADMIN_TOKEN="$(openssl rand -hex 32)"
cargo run
```

Keep the token secret and enter it in the review UI. Publishing JavaScript grants trusted same-origin application privileges; it is not sandboxed. See [Submission setup, security, and workflow](docs/submissions.md) for limits, deployment precautions, persistence, and APIs.

For repository-authored simulations, add an entry to `public/simulations/catalog.json` and `public/simulations/<id>.js`; no homepage or routing changes are needed. Restart Axum to register the new routes. Controls, readouts, explanations, graphs, lessons, and checks are slotted into the shared shell. Definitions cannot provide HTML, CSS, custom layout trees, or arbitrary module URLs.

See [Simulation authoring](docs/simulation-authoring.md) for the schema, module contract, examples, and verification checklist. All seven existing simulations have been migrated.

## Completion certificates

After exploring any simulation, students can enter their name in **Finished exploring?** to create a completion certificate, then **Print / save as PDF**. The certificate includes the simulation, issue date, guided experiments started/completed during this visit, and any unfinished or latest locally saved Check Understanding result. Regenerate it after further activity to update the record.

Simulation exploration is marked **not recorded** until a student uses a simulation control or canvas. Its **time spent** is a local estimate of visible time after interaction, paused after 60 seconds without another interaction. Hidden tabs and time away in the browser Back/Forward cache are excluded; interact again to resume. Regenerate the certificate to update the time.

Names and certificates stay on the page: they are not saved in browser storage or sent to a server. Guided participation and exploration time reset on reload; existing CFU persistence is unchanged. These are participation records, not verified qualifications or proof of mastery (guided steps can be skipped).

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
