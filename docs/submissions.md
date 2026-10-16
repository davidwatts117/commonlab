# Public submissions and maintainer review

CommonLab serves an authoring UI at **`/submit.html`** and a private review queue at **`/review.html`**. Anyone can draft a definition and either choose an installed engine or provide a new JavaScript module. Submitting to the server requires a contributor account at `/account.html`. The optional display name is not proof of identity; ownership comes from the authenticated account. See [Contributor accounts](contributors.md). Approved contributors can also request [AI-authored private drafts](ai-generation.md); generation never bypasses this review workflow.

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
4. Add approved components, explanation cards, and graphs with the builder buttons. Use the **visual editors** to edit card titles/formulas/paragraphs and question prompts, answer IDs/labels, correct answers, explanations, question use/type, and bank IDs/versions. Cards/questions can be reordered or removed. Control/graph details and lessons still use advanced JSON. Both editors update the same definition, and JSON can be imported.
5. For an installed engine, retain its required UI slot roles and choice values. The server checks these bindings against the built-in definition; extra controls are not automatically given physics behavior. For a new engine, paste/upload JavaScript exporting `mount(ui)` and returning `{ app }` (plus `adapter` for lessons).
6. Validate and preview the **layout only**. Canvases are blank and physics, lessons, and assessments do not run. Definitions never interpret HTML. JavaScript imports are never evaluated in this UI.
7. Validate, then choose **Download complete bundle** for safekeeping before submitting. This saves the definition **and** engine code/choice and submitter name. Definition-only export intentionally omits engine code. The server returns a receipt number and `pending` status.

Legacy anonymous submissions remain reviewable, but cannot be claimed by a contributor account. New submissions are linked to the signed-in contributor; open `/contributions.html` to filter your submissions, read feedback/history, and edit/resubmit them. Automatic notifications and verified real-world identities are not provided. Submitted simulation and assessment IDs are reserved across all statuses, including rejection/withdrawal. Use **Edit and resubmit** to keep the same simulation ID; the editor also reopens at `/submit.html?edit=<receipt-id>`. A new submission is for a different simulation. Each assessment bank must have a unique ID so unrelated simulations do not share localStorage results. Template copies receive a new bank ID automatically.

### Visual editing and portable drafts

Question-ID changes update lesson checkpoint references automatically. Answer-ID changes preserve their answer keys, including incremental typing. Referenced questions/banks cannot be deleted through the visual editor until their lesson references are removed in JSON. At least two choices are kept per question; after deleting a correct choice, select the replacement answer explicitly. Switching from multiple to single answer retains only the first selected answer. Validation catches incomplete prompts, invalid IDs, missing correct answers, and invalid lesson/check usage before export/submission.

The UI tolerates temporarily unfinished fields so authors can fix them without switching back to JSON. Corrupted structural JSON instead produces a repair message. Changing a question's answer type preserves keyboard focus. Text remains literal in both editors and layout previews.

**Restore complete submission bundle** loads a downloaded `*.submission.json`, replacing the current draft after validation. Format version `bundleVersion: 1` contains `definition`, `submittedBy`, and `source`, where `source` is either `{ kind: "installed", engineId }` or `{ kind: "javascript", moduleCode }`. Unknown fields, mixed sources, unavailable installed engines, invalid definitions, and oversized code are rejected **before changing the current draft**. Imports never execute module text. A bundle downloaded on another deployment can reuse an installed engine only if that engine is available locally.

Bundle files and definition-editor/import text are bounded to 1 MiB; compact serialized definitions still have the server's 64 KiB limit, and code remains limited to 128 KiB. Whitespace does not consume the serialized-definition budget. No draft or code is automatically saved to localStorage/sessionStorage; keep downloaded bundles private and never include credentials. Unsaved changes can be lost on navigation, reload, or template changes: export a valid bundle first.

## Review workflow

1. Open `/review.html`, authenticate with the token, and select a pending submission. The queue is paginated and can also show published, rejected, or withdrawn records. **Live now** lists every publicly served simulation regardless of its newest revision's status; a live entry whose latest revision is pending or rejected does not appear under Published.
2. Inspect the definition, source text, and installed-engine binding requirements. The optional layout preview is inert with respect to submitted engine code. Source is placed in readonly textareas, never inserted as HTML, evaluated, or dynamically imported.
3. Review scientific accuracy, accessibility, performance, slot bindings, lesson adapter names, assessment keys, and the module contract. Inspect **every import and dependency** as well as network/storage access and DOM manipulation.
4. Test new engines only in an isolated disposable environment with no real credentials, production data, or access to the reviewer browser. This application does not provide a code sandbox or automatic security review.
5. Publish or reject. Publishing uploaded code requires an explicit checkbox confirming personal code/dependency review; the API also enforces this confirmation. Rejection requires a note.
6. Published definitions immediately join the homepage/catalog and receive `/simulations/<id>`, `.html`, and `.js` routes. No restart or repository edit is required. Reused engines get a generated module re-exporting the installed `mount` function.
7. To remove a publication, select it in the **Live now** queue and withdraw it with a note. Subsequent catalog/module/page requests no longer expose it. Already loaded/downloaded code, existing browser state, and code side effects cannot be revoked.
8. Lock the queue when finished. The UI clears its token, private source, and definition. Leaving the page also locks it. The token is kept in tab memory only, not localStorage/sessionStorage or cookies.

Each revision transitions `pending → published/rejected`. Owner edits create a new pending revision. A separate approved snapshot remains public while newer revisions are pending/rejected; approval replaces it atomically. Withdrawal removes that snapshot, including while another revision is pending/rejected. Review requests include the inspected revision; stale decisions return `409`. Review notes/timestamps and transition history are visible to the owner, so never put administrative secrets in notes. This is a shared-token maintainer workflow, not individual administrator accounts or a tamper-proof review audit trail.

**Publishing JavaScript grants trusted same-origin application privileges.** Approval is a maintainer's explicit trust decision, not proof that code is safe. Do not approve unknown code just to try it. The declarative UI schema constrains data, not the authority of a published engine.

## Validation and abuse limits

- Request body: at most **256 KiB**.
- Serialized definition: at most **64 KiB**; module source: at most **128 KiB**.
- Submitter name: at most 100 characters; review note: at most 1,000.
- Closed server-side JSON Schema (`schema/simulation.schema.json`) plus Rust cross-field checks reject unknown/raw HTML/CSS/module fields, duplicate slots/options/IDs, reserved shell IDs, invalid defaults, bad answer keys, and invalid lesson references/conditions. The browser also validates definitions.
- Individual canvas dimensions: 1–4096 pixels; combined area at most 16,777,216 pixels. Schema bounds also limit arrays and text lengths.
- Global persisted quotas: **100 combined submissions/edits per hour**, **500 pending**, **2,000 retained records**, **50 content revisions per submission**. Capacity/rate failures return `429`. These are not per-user quotas; an attacker can still exhaust the public queue. Archive records operationally when retention capacity is reached.
- Review endpoints require a bearer token on every request. Contributors authenticate with HttpOnly cookies and a same-origin request header; maintainers still use bearer tokens. No permissive CORS is enabled. API/catalog/submitted-module responses use `Cache-Control: no-store`; submitted JavaScript is served with its proper MIME type and `nosniff` only after publication. Unapproved source is never available at public module routes. A submission with a pending/rejected revision can still serve its earlier approved snapshot.

For an internet-facing deployment, terminate **HTTPS**, add reverse-proxy IP rate limits/request timeouts/connection limits, monitor queue capacity, and consider a CAPTCHA if abuse warrants it. Never expose the repository-wide development file server. Do not embed credentials in physics engines, even approved ones.

## Storage and deployment changes

SQLite uses WAL and versioned initialization (`user_version = 4`, including contributors, session digests, ownership, authentication throttling, draft revisions, approved snapshots, bank reservations, metadata history and private AI generation jobs/permissions). Database work runs on blocking workers, outside Axum's async executor. Insertion quotas and review transitions use immediate transactions, including when multiple processes share the same SQLite database.

Back up with SQLite's backup facilities, for example:

```sh
sqlite3 data/commonlab.sqlite3 ".backup '/secure/backups/commonlab.sqlite3'"
```

Do not copy only the main database while it is actively writing: the WAL may contain committed data. Protect backups because they include private drafts and source. No deletion/retention UI is provided in this initial version.

When changing built-in definitions/engines, preserve the slot and choice-value contracts used by published variants. Startup fails if a built-in simulation/bank ID conflicts with a pending/published submission or a published variant references a removed/incompatible engine. Resolve collisions or withdraw affected publications using the old deployment before upgrading. The startup error names the blocking submission. If the new deployment is already in place, rename a conflicting built-in, or withdraw an incompatible publication offline with the server stopped:

```sh
DATABASE_PATH=data/commonlab.sqlite3 commonlab withdraw <submission-id> "Installed engine changed"
```

This records an `operator` withdraw event visible in the owner's history, exactly like a maintainer withdrawal. Back up the database first. New engine code is stored in SQLite, not written into `public/` or the Git repository.

## APIs and verification

- `GET /api/submissions/config`, `GET /api/submissions/engines`: availability, limits, installed engine IDs.
- `POST /api/submissions` (contributor cookie and `X-CommonLab-Request: 1` required): `{ definition, submittedBy?, engineId? | moduleCode? }`; returns `{ id, status: "pending" }`.
- `GET /api/admin/submissions?status=pending&before=<id>`: authenticated summary pages (20 records, `hasMore`). `status` is `pending`, `published`, `rejected`, `withdrawn`, or `live` (anything currently public); each item includes `live` and `publishedRevision`.
- `GET /api/admin/submissions/<id>`: authenticated definition/source detail.
- `POST /api/admin/submissions/<id>/review`: authenticated `{ decision: "publish" | "reject" | "withdraw", revision, codeReviewed?, note? }`.
- `GET /api/contributor/submissions?status=all&before=<id>`: owner-only summary pages of 20, with `hasMore`. Also accepts `status=live`.
- `GET /api/contributor/submissions/<id>` and `/history`: owner-only private draft and metadata history.
- `PUT /api/contributor/submissions/<id>`: normal submission payload plus current `revision`; saves/resubmits atomically.
- `GET /simulations/catalog.json`: built-ins plus published definitions, never private queue metadata/source.

Run `cargo test`, `node --test tests/*.test.mjs`, and `npm run test:browser`. Server tests cover privacy/auth, explicit code approval, validation/size limits, persistence, quotas/pagination, engine reuse, rejection/withdrawal, and database path isolation. Browser tests exercise the complete author → review → publish → withdraw flow, prove uploaded code is not fetched/executed in author/review previews, verify literal-text rendering, and mount a published built-in-engine variant with learning UI. These tests are not a scientific/security/accessibility audit of future submitted engines.
