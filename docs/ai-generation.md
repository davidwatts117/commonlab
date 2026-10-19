# Controlled pi simulation generation

AI generation is **off by default**. Registration does not grant generation access. Maintainers explicitly grant/revoke individual accounts at `/review.html` → **Manage AI generation access**. Contributors use `/generate.html` (linked from Account). Generated results are private complete drafts, not publications or moderation submissions. Open a successful result in the existing authoring editor, inspect/edit it, and explicitly submit it for human review.

## Architecture and trust boundaries

- Axum owns contributor permissions, consent, SQLite jobs, quotas, worker leases and artifact ownership. SQLite migration 4 preserves existing data and defaults every contributor's generation permission to false. Grant/revoke metadata is recorded separately.
- A separate containerized Node worker polls an authenticated API. It never opens SQLite or receives an administrator token, contributor cookie, username or account ID. It receives only an opaque job ID, requested topic, assigned simulation ID and a random per-job lease.
- The supervisor owns the worker credential. It starts a disposable child process per job with an explicit environment allowlist: model configuration/key, temporary HOME, PATH and locale. The worker token and application URL are not passed to the agent child.
- The child embeds pinned **`@earendil-works/pi-coding-agent` 1.2.0**, using its real `createAgentSession` SDK. It supplies an explicit resource loader, in-memory settings/session, temporary credential/config paths and a fixed system prompt. No user/project settings, AGENTS files, extensions, skills, prompt templates, MCP servers, model cycling or automatic resource discovery are loaded. No sessions are persisted.
- Active tools are exactly `authoring_reference`, `validate_draft`, and `finish_draft`. References are fixed read-only authoring documentation/schema, not arbitrary paths. Validation checks the closed schema, browser cross-field rules, assigned IDs and JavaScript syntax without executing source. Generated engines must be self-contained, declare only functions at module scope, and export synchronous `mount(ui)`; static/dynamic imports are rejected. There are no bash, file-write, general file-read, browser, network, installation or publication tools.
- The model can request code but cannot run it. Static checks and prompt instructions are **not** a security or scientific audit. Approved engines still run with trusted same-origin privileges; human review of every engine remains mandatory. Do not publish a generated engine just to try it. There is no engine execution/testing sandbox in this feature.
- Provider/model are selected only by the operator. Supported providers are `anthropic`, `openai`, `google`, and `openrouter`, using explicit API keys and a model in pi's catalog. Ambient host pi credentials/OAuth, custom endpoints and contributor-supplied providers/keys are not supported. Requests include the contributor's requirements, trusted references and generated content, but not the contributor's identity/session. Provider retention/billing policies still apply.

## Limits and failure behavior

- Prompt: 8,000 UTF-8 bytes; provider-processing consent required on every request.
- Three attempts per contributor per rolling 24 hours; 20 globally; one queued/running request per contributor, ten active globally, one running globally, 500 retained jobs. Failures/cancellations consume quota. The UI shows the latest 50 owned requests; older IDs remain accessible to their owner.
- Six provider requests per job, at most 8,192 output tokens per request, and 128 KiB serialized provider context. Compaction, cache warming and automatic retries are disabled. No further provider call is allowed after finalization.
- Supervisor kills the child after five minutes, on excessive output (220 KiB), when a lease check reports cancellation/revocation, or after three consecutive failed lease checks (checked every five seconds, so one network blip does not abort a job). A worker lease expires after six minutes; expired jobs fail on the next queue/status access and are never automatically regenerated.
- A worker stopped with SIGTERM/SIGINT kills its child immediately and releases the job back to the queue. The job runs again from the start when a worker next claims it, which **incurs another model run** but does not use another of the contributor's attempts. A crashed or killed worker cannot release its job; that lease expires and the job fails as above.
- Definition/code limits remain 64/128 KiB. Axum independently revalidates completed data; only the owner can retrieve the artifact. The artifact uses the existing inert complete-bundle format.
- Cancellation/revocation prevents result acceptance immediately, but stopping an in-flight provider request is best effort and cannot refund incurred charges. Existing completed drafts remain accessible to their owner after permission revocation.

These are resource/request limits, **not a guaranteed dollar cap**. Use a dedicated provider project/key with provider-side spending controls and monitor usage. Provider pricing, token accounting and requests already in flight are outside this application's control. Never put a broadly privileged personal provider key in the worker.

## Deploy the isolated worker

1. Back up SQLite before upgrading. Configure a random service credential **different from** `ADMIN_TOKEN` on Axum:

   ```sh
   export GENERATION_WORKER_TOKEN="$(openssl rand -hex 32)"
   cargo run
   ```

   Leave it unset to disable new generation and worker claims. Existing private results remain readable. This setting does not start a worker or contact a model by itself. Removing `ADMIN_TOKEN` alone does not disable previously granted generation access; remove the worker configuration to stop new runs.

2. Terminate HTTPS for the application. Restrict `/api/worker/` at your reverse proxy/firewall to the worker network where possible. Every worker request additionally requires its separate bearer token; responses are non-cacheable. Rotating the worker token requires restarting both services. Do not enable permissive CORS or expose HTTP credentials over an untrusted network.

3. Copy `worker/.env.example` to `worker/.env`, set mode `0600`, and fill its required values. Use your application **origin** for `CL_API_BASE_URL`, not an arbitrary URL/path. Set the same worker token as Axum, choose an explicit supported provider/model, and supply a dedicated model API key. No default model or credential is selected for you. Never run `docker compose config` into public logs: resolved configuration contains credentials. Production secrets management is preferable to an env file.

4. Start from the repository root:

   ```sh
   docker compose --project-directory worker -f worker/compose.yaml up --build -d
   ```

   The supplied configuration runs the complete worker as UID 10001 with a read-only filesystem, 128 MiB temporary filesystem, dropped capabilities, no-new-privileges, 64-process/one-CPU/1-GiB limits, no exposed ports and **no host mounts**. Its build context is allowlisted: no database, `.git`, runtime secrets or host pi directory is copied. Do not mount the Docker socket, repository, application data, home directory or pi config into it. Do not run it as root or weaken isolation for production.

5. Apply deployment-specific **egress rules** allowing only the application and chosen provider. Ordinary Docker bridge networking is not an egress allowlist; the compose file does not configure your firewall. The worker necessarily has the credentials and network access you give it. Container/dependency compromise remains a threat; keep runtime/dependencies patched and credentials narrowly scoped. If the application is loopback-bound, a separate container cannot reach that loopback listener—use a private service network or the HTTPS reverse proxy. `CL_WORKER_ALLOW_HTTP=true` is only for explicitly trusted private-network development.

6. Grant a registered contributor access via the maintainer UI. Submit a small topic at `/generate.html`, refresh its status, then open the result in the editor. Code remains inert there. The normal explicit maintainer code-review confirmation is still required for publication.

Protect database/WAL/backups: generation prompts, private source, lease digests and permission history are private. Retention is bounded and fail-closed; there is no automatic deletion or archive UI. Establish a retention/backup policy before reaching 500 jobs. Only the current job artifact is retained, not a transcript of hidden reasoning or all intermediate source.

## APIs

Contributor cookie required; mutations also require `X-CommonLab-Request: 1`:

- `GET /api/generation/config`: operator configuration, this account's access and quotas.
- `POST /api/generation/jobs`: `{ prompt, acceptProviderProcessing: true }`; returns 202 with receipt/status.
- `GET /api/generation/jobs`: latest 50 owner-only summaries, excluding prompt/source.
- `GET /api/generation/jobs/<id>`: owner-only prompt, status, errors and complete artifact when successful.
- `POST /api/generation/jobs/<id>/cancel`: cancel queued/running work; stale transitions return 409.

Maintainer bearer required: `POST /api/admin/generation/access` with `{ username, allowed }`. New contributor accounts start disallowed. Contributor sessions and worker tokens never grant administrator privileges.

Worker bearer required: `POST /api/worker/generation/claim` returns a protocol-1 job/lease or null; `POST /api/worker/generation/<id>/check` with `{ lease }` returns whether it is still active; `POST /api/worker/generation/<id>/complete` with `{ lease, model, artifact }`, where artifact is `{ definition, moduleCode }` or null on failure. `POST /api/worker/generation/<id>/release` with `{ lease }` returns a running job to the queue without charging the contributor; the supervisor uses it when stopped (SIGTERM/SIGINT). Expired, revoked, cancelled, released and duplicate completions return 409. Leases are random and stored only as digests.

## Verification

```sh
cargo fmt --check
cargo clippy --all-targets -- -D warnings
cargo test
node --test tests/*.test.mjs
npm ci --prefix worker --ignore-scripts
npm test --prefix worker
npm run test:browser
```

Worker tests exercise the real pi SDK with a scripted provider stream: they assert the dedicated tool allowlist, finalize a valid draft, reject invalid/side-effectful source, and enforce provider-request/context/output limits. No paid model calls are needed. Rust/browser tests cover permissions, consent, CSRF, separate credentials, private results, leases, cancellation/revocation, quotas, and generation → inert editor → explicit moderation submission. Container smoke testing has also passed with non-root/read-only/network-disabled settings and a scripted model. Scientific usefulness and live provider behavior still require operator-funded acceptance testing; automated tests are not proof of safe/scientifically correct future generations.
