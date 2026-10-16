# Contributor accounts

`/account.html` provides username/password registration, sign-in, and sign-out. New server submissions require a signed-in contributor and are linked to their account in the existing private SQLite database (`DATABASE_PATH`, default `data/commonlab.sqlite3`). Browsing simulations, local authoring, previews, and bundle export remain available without an account. Maintainer access still requires the separate `ADMIN_TOKEN`. AI generation is a separate explicit maintainer-granted permission, off for new accounts; see [Controlled AI generation](ai-generation.md).

Usernames are case-insensitive, canonical lowercase ASCII handles of 3–32 characters: letters, digits, `_`, `-`, starting with a letter. Passwords require at least 12 characters and at most 256 UTF-8 bytes. Use a password manager; this initial account implementation has no email verification or self-service password recovery.

## Persistence and security

- Database version 4 atomically migrates existing submissions without deleting their data. Legacy anonymous submissions retain a NULL owner and cannot be claimed by matching an author name.
- `contributors` holds salted Argon2id password hashes, never plaintext passwords. `contributor_sessions` stores only SHA-256 digests of cryptographically random 256-bit tokens.
- Sessions expire after seven days, survive server restarts, rotate on login, and are revoked by logout. Each account is limited to eight active sessions.
- Cookies are HttpOnly, SameSite=Strict, and scoped to `/`. `COOKIE_SECURE=true` adds Secure and uses a `__Host-` cookie name. Defaults: false for loopback binds, true for non-loopback binds. Public deployments **must use HTTPS and secure cookies**. Explicitly configure this when TLS terminates at a proxy; forwarded headers are not trusted to change cookie security.
- Contributor state-changing requests require `X-CommonLab-Request: 1`. The server enables no permissive CORS, preventing cross-origin browser requests from setting that header. Sessions/credentials are never stored in localStorage or submission bundles.
- Authentication bodies are limited to 8 KiB; expensive hashing runs on blocking workers, with at most four concurrent hash operations. Persisted limits allow 20 attempts per username per ten minutes and 500 globally per hour. These limits include registration and login; targeted throttling can temporarily lock out a username, so add reverse-proxy IP rate limiting and abuse monitoring for public deployment. Registration capacity is 10,000 accounts.
- New submissions derive ownership from the validated session, never a posted account ID or optional display name. A contributor session does not grant administrator privileges.

Keep the database, journals and backups outside `public/` and protect filesystem permissions. Backups now contain password hashes and session digests as well as private source. Published engine code is still trusted same-origin JavaScript: it can act with a signed-in user's browser privileges, so maintainers must review code/dependencies carefully. Account cookies are not a sandbox for approved engines.

## APIs

- `POST /api/auth/register`: `{ username, password }`, creates an account and session.
- `POST /api/auth/login`: same shape; rotates the browser session.
- `GET /api/auth/me`: authenticated `{ id, username }`, or 401.
- `POST /api/auth/logout`: revokes the current session and clears its cookie.

All responses are non-cacheable. Registration returns 201, duplicate usernames 409, invalid credentials 401, malformed credentials 422, missing request header 403, and throttling 429.

## Editing and resubmission

Open `/submit.html?edit=<receipt-id>` while signed in to load your saved definition and engine source as inert text. Only the owner can read/edit it; a different contributor receives the same 404 as a nonexistent ID. Bookmark this URL. The simulation ID cannot change, and existing anonymous records cannot be claimed.

`GET /api/contributor/submissions/<id>` returns the current private draft, revision, status, feedback, and published revision. `PUT` to that URL accepts the normal submission body plus its current `revision`; include the contributor cookie and request header. A successful save increments the revision and returns it to `pending`. Stale saves and stale maintainer approvals fail with 409 instead of overwriting newer work. Export your local bundle before reloading after a conflict.

Pending, rejected, withdrawn, and published submissions can be revised. Approved definitions/code live in separate SQLite snapshot columns: saving or rejecting a new revision **does not change the live simulation**. Approval atomically replaces the live snapshot. Maintainers can withdraw an older live snapshot even while a new revision is pending/rejected; a pending revision remains pending. Review requests must include the inspected `revision`, and uploaded code always needs explicit review confirmation.

Bank IDs remain reserved to their submission even after removal/renaming. Changed question banks require a greater version than the last submitted content for that ID, including removed/reintroduced banks. The editor bumps the current bank's version automatically when appropriate; imported older bank IDs may require a manual version increase. Limits: 50 content revisions per submission, 100 combined creations/edits per hour globally, 500 pending, 2,000 retained submissions. Metadata events record transitions/feedback; this is not a complete archive of every historical source revision.

## Status, feedback and history

Open **`/contributions.html`** from the homepage, account page, or authoring interface. The private dashboard lists only your submissions, with all/pending/published/rejected/withdrawn revision filters plus a **Live now** filter for anything currently public and pages of 20. Select an item for feedback, creation/update dates, chronological transition history, an edit link, and a link to its live simulation when one exists. A rejected revision can coexist with an older published revision; the dashboard labels both explicitly.

- `GET /api/contributor/submissions?status=all&before=<id>` returns `{ items, hasMore }` summaries without definitions or engine source. `status` may also be `live`; each item includes `live` and `publishedRevision`.
- `GET /api/contributor/submissions/<id>/history` returns `{ id, events }` with revision, action, resulting status, actor role, note, and timestamp. Other contributors receive 404; anonymous requests receive 401.
- Status refreshes on opening/focusing the dashboard, changing filters, or clicking **Refresh status**. There is no email notification or live push service.
- Notes/titles are rendered literally, never as HTML. Private dashboard content clears on page exit and is reauthenticated on return. Nothing is persisted in browser storage.

SQLite stores all accounts, revisions, current/private source, approved snapshots, reservations and review events. Migrations are automatic and transactional; back up before upgrading. Only the current draft and live source snapshot are retained, not a downloadable source archive for each historical revision. Metadata history survives server restarts.
