# Contributor accounts

`/account.html` provides username/password registration, sign-in, and sign-out. New server submissions require a signed-in contributor and are linked to their account in the existing private SQLite database (`DATABASE_PATH`, default `data/commonlab.sqlite3`). Browsing simulations, local authoring, previews, and bundle export remain available without an account. Maintainer access still requires the separate `ADMIN_TOKEN`.

Usernames are case-insensitive, canonical lowercase ASCII handles of 3–32 characters: letters, digits, `_`, `-`, starting with a letter. Passwords require at least 12 characters and at most 256 UTF-8 bytes. Use a password manager; this initial account implementation has no email verification or self-service password recovery.

## Persistence and security

- Database version 2 atomically migrates existing submissions without deleting their data. Legacy anonymous submissions retain a NULL owner and cannot be claimed by matching an author name.
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

All responses are non-cacheable. Registration returns 201, duplicate usernames 409, invalid credentials 401, malformed credentials 422, missing request header 403, and throttling 429. Account-specific editing and status views are the next stages of the contributor workflow.
