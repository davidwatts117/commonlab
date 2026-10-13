# Public submissions and maintainer review

CommonLab serves an authoring UI at **`/submit.html`** and a private review queue at **`/review.html`**. Anyone can submit a definition and either choose an installed engine or upload a new JavaScript module. No contributor account is required. Names are optional and unverified.

## Enable submissions

Run Axum with a securely generated administrator token:

```sh
export ADMIN_TOKEN="$(openssl rand -hex 32)"
cargo run
```

Keep the token in a password manager or your deployment's secret store. Enter it in the review UI; never put it in a URL, committed file, or a definition. Tokens must contain 32–256 ASCII letters, digits, hyphens, underscores, or dots. Minimum length is not a substitute for secure randomness.

Configuration:

| Variable | Default | Purpose |
| --- | --- | --- |
| `DATABASE_PATH` | `data/commonlab.sqlite3` | Persistent SQLite database; parent directories are created at startup |
| `ADMIN_TOKEN` | unset | Bearer token authorizing every review API request |

Without `ADMIN_TOKEN`, new submissions and review actions are disabled. The UI still supports local drafting, layout previews, and JSON download. Previously published simulations remain public. Restart to rotate or remove the token; requests using the old token then fail.

`DATABASE_PATH` must resolve **outside `PUBLIC_DIR`**. Paths through symlinks into public assets are rejected, including dangling database symlinks. On Unix, newly created database files have mode `0600`; protect existing files, their directory, backups, and SQLite journals with appropriate permissions too. The database and runtime files are ignored by Git.

Deploy both the executable and `public/`, with a persistent writable volume for the database. The submission schema is compiled into the executable. A plain static host/GitHub Pages supports built-in simulations and local drafting, not the submission API or SQLite publication.

## Author workflow

1. Open `/submit.html` from the homepage.
2. Select a built-in physics engine/template, or **New JavaScript engine**. Changing this selection replaces the definition with its template.
3. Set a unique lowercase simulation ID, title, subject, summary, and canvas dimensions.
4. Add approved components, explanation cards, and graphs with the builder buttons. Edit their values in the JSON editor; use a built-in template for lesson/question-bank examples. JSON files can also be imported.
5. For an installed engine, retain its required UI slot roles and choice values. The server checks these bindings against the built-in definition; extra controls are not automatically given physics behavior. For a new engine, paste/upload JavaScript exporting `mount(ui)` and returning `{ app }` (plus `adapter` for lessons).
6. Validate and preview the **layout only**. Canvases are blank and physics, lessons, and assessments do not run. Definitions never interpret HTML. JavaScript imports are never evaluated in this UI.
7. Download your definition for safekeeping, then submit for review. The server returns a receipt number and `pending` status.

Anonymous contributors cannot edit or retrieve private drafts, view review notes, receive automatic notifications, or verify another contributor's identity. Submitted simulation and assessment IDs are reserved across all statuses, including rejection/withdrawal. Use a new ID for a revised submission. Each assessment bank must have a unique ID so unrelated simulations do not share localStorage results. Template copies receive a new bank ID automatically.

## Review workflow

1. Open `/review.html`, authenticate with the token, and select a pending submission. The queue is paginated and can also show published, rejected, or withdrawn records.
2. Inspect the definition, source text, and installed-engine binding requirements. The optional layout preview is inert with respect to submitted engine code. Source is placed in readonly textareas, never inserted as HTML, evaluated, or dynamically imported.
3. Review scientific accuracy, accessibility, performance, slot bindings, lesson adapter names, assessment keys, and the module contract. Inspect **every import and dependency** as well as network/storage access and DOM manipulation.
4. Test new engines only in an isolated disposable environment with no real credentials, production data, or access to the reviewer browser. This application does not provide a code sandbox or automatic security review.
5. Publish or reject. Publishing uploaded code requires an explicit checkbox confirming personal code/dependency review; the API also enforces this confirmation. Rejection requires a note.
6. Published definitions immediately join the homepage/catalog and receive `/simulations/<id>`, `.html`, and `.js` routes. No restart or repository edit is required. Reused engines get a generated module re-exporting the installed `mount` function.
7. To remove a publication, select it in the published queue and withdraw it with a note. Subsequent catalog/module/page requests no longer expose it. Already loaded/downloaded code, existing browser state, and code side effects cannot be revoked.
8. Lock the queue when finished. The UI clears its token, private source, and definition. Leaving the page also locks it. The token is kept in tab memory only, not localStorage/sessionStorage or cookies.

Transitions are deliberately one-way: `pending → published` or `pending → rejected`, and `published → withdrawn`. Review actions are transactional; duplicate/stale decisions return `409`. Review notes/timestamps are retained privately. This is a shared-token maintainer workflow, not individual administrator accounts or a tamper-proof review audit trail.

**Publishing JavaScript grants trusted same-origin application privileges.** Approval is a maintainer's explicit trust decision, not proof that code is safe. Do not approve unknown code just to try it. The declarative UI schema constrains data, not the authority of a published engine.

## Validation and abuse limits

- Request body: at most **256 KiB**.
- Serialized definition: at most **64 KiB**; module source: at most **128 KiB**.
- Submitter name: at most 100 characters; review note: at most 1,000.
- Closed server-side JSON Schema (`schema/simulation.schema.json`) plus Rust cross-field checks reject unknown/raw HTML/CSS/module fields, duplicate slots/options/IDs, reserved shell IDs, invalid defaults, bad answer keys, and invalid lesson references/conditions. The browser also validates definitions.
- Individual canvas dimensions: 1–4096 pixels; combined area at most 16,777,216 pixels. Schema bounds also limit arrays and text lengths.
- Global persisted quotas: **100 submissions/hour**, **500 pending**, **2,000 retained records**. Capacity/rate failures return `429`. These are not per-user quotas; an attacker can still exhaust the public queue. Archive records operationally when retention capacity is reached.
- Review endpoints require a bearer token on every request. No cookie authentication or permissive CORS is enabled. API/catalog/submitted-module responses use `Cache-Control: no-store`; submitted JavaScript is served with its proper MIME type and `nosniff` only after publication. Pending, rejected, and withdrawn source is never available at public module routes.

For an internet-facing deployment, terminate **HTTPS**, add reverse-proxy IP rate limits/request timeouts/connection limits, monitor queue capacity, and consider a CAPTCHA or contributor authentication if abuse warrants it. Never expose the repository-wide development file server. Do not embed credentials in physics engines, even approved ones.

## Storage and deployment changes

SQLite uses WAL and versioned initialization (`user_version = 1`). Database work runs on blocking workers, outside Axum's async executor. Insertion quotas and review transitions use immediate transactions, including when multiple processes share the same SQLite database.

Back up with SQLite's backup facilities, for example:

```sh
sqlite3 data/commonlab.sqlite3 ".backup '/secure/backups/commonlab.sqlite3'"
```

Do not copy only the main database while it is actively writing: the WAL may contain committed data. Protect backups because they include private drafts and source. No deletion/retention UI is provided in this initial version.

When changing built-in definitions/engines, preserve the slot and choice-value contracts used by published variants. Startup fails if a built-in simulation/bank ID conflicts with a pending/published submission or a published variant references a removed/incompatible engine. Resolve collisions or withdraw affected publications using the old deployment before upgrading. New engine code is stored in SQLite, not written into `public/` or the Git repository.

## APIs and verification

- `GET /api/submissions/config`, `GET /api/submissions/engines`: availability, limits, installed engine IDs.
- `POST /api/submissions`: `{ definition, submittedBy?, engineId? | moduleCode? }`; returns `{ id, status: "pending" }`.
- `GET /api/admin/submissions?status=pending&before=<id>`: authenticated summary pages (20 records, `hasMore`).
- `GET /api/admin/submissions/<id>`: authenticated definition/source detail.
- `POST /api/admin/submissions/<id>/review`: authenticated `{ decision: "publish" | "reject" | "withdraw", codeReviewed?, note? }`.
- `GET /simulations/catalog.json`: built-ins plus published definitions, never private queue metadata/source.

Run `cargo test`, `node --test tests/*.test.mjs`, and `npm run test:browser`. Server tests cover privacy/auth, explicit code approval, validation/size limits, persistence, quotas/pagination, engine reuse, rejection/withdrawal, and database path isolation. Browser tests exercise the complete author → review → publish → withdraw flow, prove uploaded code is not fetched/executed in author/review previews, verify literal-text rendering, and mount a published built-in-engine variant with learning UI. These tests are not a scientific/security/accessibility audit of future submitted engines.
