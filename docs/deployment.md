# Deploying CommonLab

This is the end-to-end, single-host Docker deployment guide: the web app, persistent database, HTTPS, optional AI worker, and ongoing operations. Run commands from the repository root unless noted.

## 1. What runs where

```text
Browser ── HTTPS ── reverse proxy ── app:8000 ── SQLite (/data)
                                      ▲
                                      │ authenticated API over HTTPS
                               generation worker ── model provider
                                  (optional)
```

- **App:** Rust/Axum plus the `public/` assets, built by the root `Dockerfile`. Browsing needs no account or model provider.
- **Database:** SQLite in a Docker named volume, not inside the disposable app container. It stores accounts, sessions, private submissions, publications, and generation jobs—not student assessment answers.
- **Reverse proxy:** provides public HTTPS. The example below uses Caddy installed on the host.
- **Worker:** a separately deployed Node container that polls the app for AI-generation jobs. It is not required for browsing, contributor accounts, or manual authoring/review. It needs an operator-selected model and dedicated paid-provider key.

The two Compose files are separate stacks. Starting the root stack **does not start the worker**. No model calls happen merely because the app is running.

## 2. Prerequisites

- A Linux host with Docker Engine and the Docker Compose v2 plugin (`docker compose version`).
- A checkout of this repository. Images are built locally; CI tests them but does not publish them to a registry.
- For public access: a domain pointing at the host, inbound ports 80/443, and an HTTPS reverse proxy.
- `openssl` for generating service tokens; `curl` for the checks below.
- Enough disk space for Docker builds and growing database/backups. Rust and Node are built/provided inside the images; you do not need them installed on the host.

Use one app instance and a local Docker volume for this setup. Do not put SQLite on a shared network filesystem or assume this is a multi-host deployment recipe.

## 3. Configure and start the app

### Create the app environment

Create a private root `.env` file, without overwriting an existing configuration:

```sh
touch .env
chmod 600 .env
```

Edit it to contain:

```dotenv
# Host port; exposed on 127.0.0.1 only.
COMMONLAB_PORT=8000
# Generate with: openssl rand -hex 32
ADMIN_TOKEN=REPLACE_WITH_A_RANDOM_TOKEN
COOKIE_SECURE=true
RUST_LOG=commonlab=info,tower_http=info
```

Replace the placeholder with the output of `openssl rand -hex 32`. Save the token in a password manager; maintainers enter it at `/review.html`.

`ADMIN_TOKEN` enables new submissions and maintainer review. If you do not want those features, omit the variable entirely. Unused tokens must be **unset, not empty**; empty tokens fail startup validation. Tokens must be 32–256 ASCII letters, digits, `-`, `_`, or `.`. Use random values, not memorable passwords.

Do not set `GENERATION_WORKER_TOKEN` yet unless enabling generation in section 5. Both environment files are ignored by Git, but remain plaintext secrets on disk. Prefer your deployment's secret-management system for production. Shell environment variables override Compose `.env` values; check for stale exports when changing configuration.

### Build and launch

```sh
docker compose up --build -d
docker compose ps
docker compose logs --tail=100 app
curl --fail http://127.0.0.1:8000/healthz
```

The health endpoint should return `ok`. Adjust the URL if you changed `COMMONLAB_PORT`. The image's health check runs periodically, so initial status may be `starting`.

The supplied app configuration:

- Runs as UID/GID 10001 with a read-only root filesystem, dropped capabilities, and no-new-privileges.
- Publishes only `127.0.0.1:8000` by default, not a public network interface.
- Stores SQLite at `/data/commonlab.sqlite3` in the Compose volume `commonlab-data` (normally named `commonlab_commonlab-data` by Docker).
- Keeps assets root-owned and read-only. The build context excludes local databases, secrets, `.git`, and build output.
- Restarts unless explicitly stopped. Docker must itself be configured to start at host boot.

`docker compose down` removes containers/network but keeps the database. **Do not use `down -v` unless you intend to delete application data.** Keep the Compose project name stable so future deployments reuse the same volume.

### Local-only use

Open `http://localhost:8000`. The app container binds a non-loopback address internally, so contributor cookies default to Secure. Chrome and Firefox accept Secure cookies on `http://localhost`; Safari or plain-HTTP access using another hostname may not.

For trusted local HTTP testing only, set `COOKIE_SECURE=false` and recreate the app. Do not use that setting for public deployment.

## 4. Add HTTPS and public access

For a host-installed Caddy instance, use a Caddyfile like this (replace the domain and port):

```caddyfile
lab.example.org {
    reverse_proxy 127.0.0.1:8000
}
```

Validate/reload Caddy according to your installation. With correct DNS and reachable ports 80/443, Caddy obtains and renews the certificate. Keep `COOKIE_SECURE=true` even though the proxy-to-app connection uses loopback HTTP; forwarded headers do not change the app's cookie-security setting.

If your proxy runs in a container, its `127.0.0.1` is **not the host or app**. Connect it to a private Docker service network and proxy to the app's service address instead; do not expose port 8000 publicly as a workaround.

Before opening registration to the internet:

- Expose only the reverse proxy, not Docker's API or the database. Restrict host administration access.
- Add proxy IP rate limits, request/connection timeouts, and abuse monitoring using your proxy's supported configuration/modules. The minimal Caddy example above does not provide these controls.
- Do not cache `/api/` responses or override the app's `no-store` headers. Do not enable permissive CORS.
- Never serve the repository root with a development file server. Only the app's `public/` assets are public.
- Protect the volume, environment files, and backups. They contain private source, prompts, password hashes, and session digests.

Check the public deployment:

```sh
curl --fail https://lab.example.org/healthz
curl --fail https://lab.example.org/simulations/catalog.json
```

In a browser, test a simulation and register/sign in at `/account.html`. At `/review.html`, verify the maintainer token works. There is no email verification or self-service password recovery; plan account support accordingly.

## 5. Optional: enable AI generation

Skip this entire section if you do not want AI authoring. The ordinary application works without it.

### Configure the two services

1. Generate **another** token with `openssl rand -hex 32`, different from `ADMIN_TOKEN`.
2. Add it to the root `.env`:

   ```dotenv
   GENERATION_WORKER_TOKEN=REPLACE_WITH_THE_NEW_RANDOM_TOKEN
   ```

3. Recreate the app to load it:

   ```sh
   docker compose up -d app
   ```

4. Create the worker environment:

   ```sh
   cp worker/.env.example worker/.env
   chmod 600 worker/.env
   ```

5. Fill `worker/.env`:

   ```dotenv
   CL_API_BASE_URL=https://lab.example.org
   GENERATION_WORKER_TOKEN=THE_SAME_WORKER_TOKEN_AS_THE_APP
   CL_MODEL_PROVIDER=anthropic
   CL_MODEL_ID=REPLACE_WITH_AN_EXPLICIT_SUPPORTED_MODEL_ID
   CL_MODEL_API_KEY=REPLACE_WITH_A_DEDICATED_PROVIDER_KEY
   CL_WORKER_ALLOW_HTTP=false
   ```

Supported providers are `anthropic`, `openai`, `google`, and `openrouter`. Choose a model ID supported by the worker's pinned pi SDK catalog; no default model is chosen. Ambient pi credentials/OAuth, custom endpoints, and contributor-supplied keys are not supported. Use the application **origin**, without a path, for `CL_API_BASE_URL`.

Use a dedicated provider project/key with provider-side spending limits and usage monitoring. Application request/token limits are **not a guaranteed dollar cap**. Provider billing and retention policies apply to submitted requirements and generated content.

Never paste resolved `docker compose config` output into public logs: it contains credentials. Do not give the worker the administrator token, contributor cookies, or host pi configuration.

### Make sure the worker can reach the app

The simplest production route is the public HTTPS origin above. Ensure the worker container can resolve/reach it and the chosen provider. Restrict `/api/worker/` at the reverse proxy/firewall to the worker's network/source address where practical; each request also requires its separate bearer token.

**Do not use `http://localhost:8000` as the worker URL.** Inside its container that means the worker itself, and the root app's published port is host-loopback-only. Separate Compose stacks also do not share a service network automatically.

For private-network development, explicitly connect the services to a shared private Docker network and use the app's network alias and internal port (for example, `http://app:8000`). Only in that trusted setup set `CL_WORKER_ALLOW_HTTP=true`. The supplied files do not configure that shared network. Keep public deployments on HTTPS.

### Start the worker

```sh
docker compose --project-directory worker -f worker/compose.yaml up --build -d
docker compose --project-directory worker -f worker/compose.yaml ps
docker compose --project-directory worker -f worker/compose.yaml logs --tail=100 generation-worker
```

The worker configuration has no published ports or host mounts. It runs as UID/GID 10001, read-only, with dropped capabilities, no-new-privileges, a 128 MiB temporary filesystem, and limits of one CPU, 1 GiB RAM, and 64 processes.

Keep that isolation: do not mount the repository, database, home directory, Docker socket, or pi configuration, and do not run it as root. Configure deployment-specific egress rules allowing only the app and chosen provider; Docker bridge networking alone is **not** an egress allowlist. Keep images/dependencies patched.

### Grant access and verify the complete workflow

1. Register a contributor at `/account.html`.
2. Sign into `/review.html` with `ADMIN_TOKEN`, then use **Manage AI generation access** to approve that contributor.
3. As the contributor, open `/generate.html`, consent to provider processing, and request a small simulation. This makes a real, potentially billable model call.
4. Refresh status, open the successful private result in the editor, inspect/edit it, and explicitly submit it for review.
5. Review the code and scientific content before publication. Generated results never publish automatically.

The agent has only fixed-reference, validation, and finalization tools—no shell, general file access, or code execution. That is **not a security/scientific audit or an engine-testing sandbox**. Published JavaScript runs with trusted same-origin browser privileges. Test unknown engines only in a disposable environment without production credentials or data.

### Limits and stopping behavior

- Three attempts per contributor per rolling 24 hours; 20 globally; one running job globally. Failures/cancellations consume quota.
- At most six provider requests per job, 8,192 output tokens per request, and five minutes of child-process runtime. Additional context/output limits apply.
- A graceful worker stop kills the current child and requeues its job. Restarting runs it from scratch, potentially incurring another model charge, without another contributor attempt.
- A crash leaves a lease that expires after six minutes; the job fails on the next queue/status access rather than automatically regenerating.
- Cancellation/revocation prevents result acceptance, but cannot guarantee cancellation/refund of provider requests already in flight.
- Generation retains at most 500 jobs and has no automatic archive/deletion UI. Monitor capacity and define a retention policy.

To disable new generation, remove `GENERATION_WORKER_TOKEN` from the app's configuration and recreate the app, then stop the worker:

```sh
docker compose up -d app
docker compose --project-directory worker -f worker/compose.yaml stop
```

Existing private results remain readable. Removing `ADMIN_TOKEN` alone does not revoke previously granted generation access. Rotate the worker token on **both** services and recreate both when changing it.

## 6. Backups and restore

Back up before every upgrade and on a regular schedule. Backups contain sensitive accounts, sessions, source, and prompts; restrict access, encrypt off-host copies, and test restores.

SQLite uses WAL. **Do not copy only the main database file while the app is writing.** Either use SQLite's online backup API with appropriate tooling or stop all writers and archive the complete `/data` directory as below. The runtime image does not include the `sqlite3` CLI.

### Stopped-volume backup

Stop the worker first if deployed (an in-flight job may be requeued), then the app. The temporary backup container uses the app image's `tar`, not the application entrypoint:

```sh
# If deployed:
docker compose --project-directory worker -f worker/compose.yaml stop

docker compose stop app
mkdir -p backups
chmod 700 backups
(umask 077; docker compose run --rm -T --no-deps --user 0:0 --entrypoint tar app \
  -C /data -czf - . > "backups/commonlab-$(date -u +%Y%m%dT%H%M%SZ).tar.gz")
# Check command success and archive contents before relying on the backup.
tar -tzf backups/commonlab-YYYYMMDDTHHMMSSZ.tar.gz

docker compose up -d app
# If deployed:
docker compose --project-directory worker -f worker/compose.yaml up -d
```

Replace the timestamp placeholder in the inspection command with the actual filename. Keep the matching application revision/image and private configuration separately so you can restore the complete deployment. Never commit backups or secrets.

### Restore

Restore into an **empty** app data volume with the app and worker stopped. Do not merge a backup into a populated database directory or delete your current volume before securing a verified backup. On a fresh host, restore the checkout/configuration, build the app image with `docker compose build app`, then:

```sh
docker compose run --rm -T --no-deps --user 0:0 --entrypoint tar app \
  -C /data -xzpf - < backups/commonlab-YYYYMMDDTHHMMSSZ.tar.gz
docker compose up -d app
```

The archive preserves numeric file ownership for the app's UID/GID 10001. Confirm health, account access, and publications before starting the worker. Restored queued jobs may run and incur charges; inspect them before resuming generation. Restore private configuration securely and rotate tokens if compromise is suspected.

## 7. Updates, shutdown, and recovery

### Update

1. Back up the database and preserve the current image/revision.
2. Stop the worker, then the app.
3. Check out the desired revision and read its migration/compatibility notes.
4. Rebuild/recreate the app:

   ```sh
   docker compose up --build -d app
   docker compose ps
   docker compose logs --tail=100 app
   ```

5. Verify `/healthz`, sign-in, and existing publications, then rebuild/start the worker if used:

   ```sh
   docker compose --project-directory worker -f worker/compose.yaml up --build -d
   ```

Database migrations run automatically. Do not assume an old binary can read a migrated database; rollback may require the matching pre-upgrade database backup, losing changes since that backup.

Changing built-in simulation/engine IDs or contracts can conflict with stored submissions/publications and prevent startup. Resolve the named conflict using the previous deployment, or use offline withdrawal after backing up:

```sh
docker compose stop app
docker compose run --rm app withdraw <submission-id> "Installed engine changed"
docker compose up -d app
```

Withdrawal records an operator event. It does not erase private drafts or undo code already downloaded by browsers.

### Routine operations

```sh
# App status/logs:
docker compose ps
docker compose logs -f app
# Worker status/logs (if enabled):
docker compose --project-directory worker -f worker/compose.yaml ps
docker compose --project-directory worker -f worker/compose.yaml logs -f generation-worker
# Stop without deleting data:
docker compose --project-directory worker -f worker/compose.yaml stop
docker compose stop app
```

Environment edits require `up -d` to recreate affected services; `restart` alone does not load new Compose environment values. Rotate the administrator token by changing it and recreating the app; the previous token then stops working.

Monitor disk usage, health, restart counts, failed authentication, submission/generation capacity, and provider spend. Current retention limits also include 2,000 submissions, 500 pending submissions, and 10,000 contributor accounts; there is no general retention-management UI. Do not improvise SQL deletion against a live production database.

## 8. Troubleshooting

| Symptom | Check |
| --- | --- |
| App fails immediately | Logs; empty/invalid tokens; asset/catalog conflicts; writable `/data` owned by UID 10001; available disk space. |
| Login appears not to stick | HTTPS and `COOKIE_SECURE`; browser behavior on local HTTP; same application origin. |
| Public proxy cannot connect | App health, configured host port, and whether the proxy runs on the host or inside a container. |
| Generation is unavailable | App worker token configured, contributor explicitly approved, consent and quotas. Registration alone grants no generation access. |
| Job stays queued | Worker actually started; URL reachable from its container; matching worker tokens; valid provider/model/key; worker logs. |
| Worker fails configuration | Required worker `.env` values filled, correct Compose invocation, no stale shell overrides. |
| Job failed after worker interruption | Lease expiry/crash behavior; provider/network errors; time/context/output limits. A failed job is not automatically regenerated. |
| Requests return 429 | Authentication/submission/generation quotas or retention capacity; investigate abuse/capacity rather than bypassing limits. |

## Further technical references

This guide covers deployment without requiring the references below. For implementation contracts and detailed workflows:

- [AI generation architecture, API, limits, and safety](ai-generation.md)
- [Contributor accounts and sessions](contributors.md)
- [Submissions, moderation, storage, and recovery](submissions.md)
- [Simulation authoring and engine contract](simulation-authoring.md)
