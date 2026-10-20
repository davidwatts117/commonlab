# Controlled pi simulation generation

AI generation is **off by default**. Registration does not grant generation access. Maintainers explicitly grant/revoke individual accounts at `/review.html` → **Manage AI generation access**. Approved contributors see AI authoring links on the homepage, Account and manual authoring page, leading to `/generate.html`. Generated results are private complete drafts, not publications or moderation submissions. Open a successful result in the existing authoring editor, inspect/edit it, optionally run it in the isolated preview, and explicitly submit it for human review.

## Architecture and trust boundaries

- Axum owns contributor permissions, consent, SQLite jobs, quotas, worker leases and artifact ownership. SQLite migration 4 preserves existing data and defaults every contributor's generation permission to false. Grant/revoke metadata is recorded separately.
- A separate containerized Node worker polls an authenticated API. It never opens SQLite or receives an administrator token, contributor cookie, username or account ID. It receives only an opaque job ID, requested topic, assigned simulation ID and a random per-job lease.
- The supervisor owns the worker credential. It starts a disposable child process per job with an explicit environment allowlist: model configuration/key, temporary HOME, PATH and locale. The worker token and application URL are not passed to the agent child.
- The child embeds pinned **`@earendil-works/pi-coding-agent` 1.2.0**, using its real `createAgentSession` SDK. It supplies an explicit resource loader, in-memory settings/session, temporary credential/config paths and a fixed system prompt. No user/project settings, AGENTS files, extensions, skills, prompt templates, MCP servers, model cycling or automatic resource discovery are loaded. No sessions are persisted.
- The host exposes exactly one tool per development stage: `plan_simulation`, then `define_simulation`, then `submit_draft`. There is no model-controlled reference-reading tool. Relevant trusted documentation/schema is supplied automatically. The final tool takes engine source plus an optional revised definition; otherwise it reuses the accepted definition. A valid submission automatically completes the job. Validation checks the closed schema, browser cross-field rules, assigned IDs and JavaScript syntax without executing source. Generated engines must be self-contained, declare only functions at module scope, and export synchronous `mount(ui)`; static/dynamic imports are rejected. There are no bash, file-write, general file-read, browser, network, installation or publication tools.
- The model can request code but cannot run it. Static checks and prompt instructions are **not** a security or scientific audit. Approved engines still run with trusted same-origin privileges; human review of every engine remains mandatory. Do not publish a generated engine just to try it. There is no engine execution/testing sandbox in this feature.
- Provider/model are selected only by the operator. Supported providers are `anthropic`, `openai`, `google`, and `openrouter`, using explicit API keys and a model in pi's catalog. Ambient host pi credentials/OAuth, custom endpoints and contributor-supplied providers/keys are not supported. Requests include the contributor's requirements, trusted references and generated content, but not the contributor's identity/session. Provider retention/billing policies still apply.

## Host-controlled authoring workflow

The host owns the state machine, not the model:

1. **Science plan** (`plan_simulation`): equations, evolving state, controls, assumptions and concrete scientific/interaction checks. The stage's typed tool schema requires each part. This is an implementation plan, not a scientific audit.
2. **Controls and definition** (`define_simulation`): create the closed UI/learning definition using the supplied schema and authoring contract. The host fills assigned simulation/bank/lesson IDs and validates the definition before engine work starts.
3. **Engine implementation** (`submit_draft`): implement the accepted plan and bind the accepted UI. On a source error, retain both the definition and rejected source, return targeted diagnostics, and repair within this stage. The model can supply a revised definition if needed; both are revalidated together.

Each SDK session is restricted to one assistant turn, then disposed. The next turn receives the requirements, accepted plan/definition, relevant references and the most recent rejected result plus actual tool feedback. Planning does not carry the full schema; implementation does not repeat it. Old tool-call batches and prior drafts are not replayed. No generated source is executed.

The complete response is inspected before tool execution. More than one call, or any tool other than the current stage tool, rejects the entire batch—even if its first call is valid. Reference-reading loops are impossible: no such tool is available in any stage. Repeated batch violations fail explicitly. Validation errors are real error tool results; diagnostics select the matching UI component variant rather than listing irrelevant errors from every schema alternative. Syntax diagnostics include line/column positions.

At most four distinct rejected stage results are allowed per job; accepted stages do not consume repair allowances. Identical invalid drafts (including reordered object keys and normalized source line endings) get cached feedback; two duplicate submissions or two consecutive turns without progress stop the run. A truncated response executes no tools and gets at most one explicit shorter-response correction turn. Provider failures are not automatically retried. Every correction still counts against the six-request budget.

## Live activity and diagnostics

The generation page polls every three seconds while visible and displays a private, timestamped activity timeline: development stages, model requests, allowlisted tool names/results, static validation attempts/results and finalization. Requests can be selected independently. This is an action log, not a transcript of private reasoning, source or prompts. The authenticated worker sends only allowlisted activity codes through its current lease; each job retains at most 100 events. Only the owner can read them. Older jobs have no historical events.

Failures distinguish runtime/output limits, request/context budgets, provider authentication/rate-limit/availability errors, repeated truncation, repair exhaustion, no progress, and protocol violations. The timeline includes bounded numeric turn/request/token/context/tool-call counters, model stop reasons and up to five value-free validation issues (schema paths and allowlisted rules; syntax line/column where available). Arbitrary property names are redacted. The contributor-facing API and ordinary worker logs never include raw provider errors, credentials, generated values/source or private reasoning. Optional local operator traces are described below.

Final counters and the last validation issues are stored separately on the job and displayed even if the activity timeline is full. Completion also reserves a terminal event within the 100-event cap. Activity delivery is best effort with a bounded drain window; it cannot indefinitely delay completion. Result delivery retries transient API failures up to three times without rerunning the model; authorization, validation and stale-lease failures are not retried. Both app and worker must be upgraded together: migration 7 adds structured activity details and terminal diagnostics; old jobs default to empty diagnostics.

Additional APIs: owner-only `GET /api/generation/jobs/<id>/events`; worker-only `POST /api/worker/generation/<id>/progress` with `{ lease, code, details? }`. Worker completion accepts optional `failure` (a categorized code) and `diagnostics` (the same bounded structure); unknown failure codes map to a generic safe message. Unknown diagnostic fields, arbitrary paths/rules, oversized arrays and out-of-range counters are rejected by the server.

## Optional operator-only agent traces

Tracing is **off by default**. Set `CL_AGENT_TRACE_DIR` on the worker supervisor to an absolute private directory to enable JSONL files. No trace is stored in SQLite or exposed by any web/API endpoint. Each `generation-<job>-<time>-<uuid>.jsonl` contains the task, exact model-facing request contexts/tool schemas, completed assistant messages, tool calls/results (including SDK argument errors), stage/validation feedback and terminal outcome. Raw provider error text is retained locally after redaction. Private reasoning/thinking blocks and signatures are omitted; authorization fields, known operator credential values and common bearer/key patterns are redacted. Prompts and generated source are still sensitive: do not put secrets in requests, and protect these files/backups.

The supervisor owns the destination and gives the child a dedicated trace pipe, not the trace-directory setting or worker credential. The child has no model-accessible filesystem tools. Files are created exclusively with mode `0600` in a nonsymlinked `0700` directory. JSONL is appended during a run; on cancellation, timeout or normal failure, the supervisor saves a terminal record. A supervisor/container crash can leave a partial file without a terminal record. Completed message contents are captured, not token-by-token partial output, so a killed in-flight response may be absent.

Environment variables:

| Variable | Default | Meaning |
| --- | --- | --- |
| `CL_AGENT_TRACE_DIR` | empty/off | Absolute private destination, outside any public assets |
| `CL_AGENT_TRACE_MAX_FILES` | `50` | Retain at most this many trace files (1–1000) |
| `CL_AGENT_TRACE_MAX_BYTES` | `8388608` | Per-file cap (64 KiB–64 MiB); emits an explicit truncation marker and reserves room for terminal diagnostics |
| `CL_AGENT_TRACE_MAX_DAYS` | `7` | Delete expired files when the next trace starts (1–90 days) |

The supplied Compose files mount a **worker-only named volume** at `/var/lib/commonlab/agent-traces`. Enable by setting `CL_AGENT_TRACE_DIR=/var/lib/commonlab/agent-traces` in the appropriate `.env` and recreating the worker. Do not map it into the application container or public asset directory. A local non-container supervisor can use a private local directory instead. Configuration is checked before claiming work; a trace file creation failure prevents that job's model call. A mid-run write failure warns the operator without aborting generation. Never publish a trace or include it in ordinary logs. Retention is separate from job/SQLite retention; removal of a job does not remove its trace.

## Limits and failure behavior

- Prompt: 8,000 UTF-8 bytes by default; provider-processing consent required on every request.
- Three attempts per contributor per rolling 24 hours; 20 globally; one queued/running request per contributor, ten active globally, one running globally, 500 retained jobs. Maintainers change the per-day, global-per-day, active, retained and prompt-size values at `/review.html` → **Manage request limits** (`GET`/`PUT /api/admin/limits`). Values are stored in SQLite, apply immediately, and survive restarts. The one-running and one-active-per-contributor concurrency rules stay fixed. Failures/cancellations consume quota. The UI shows the latest 50 owned requests; older IDs remain accessible to their owner.
- Six provider requests per job, at most 8,192 output tokens per request, and 128 KiB serialized provider context. Four distinct rejected results, two duplicate/no-progress turns and one truncation correction are the additional repair bounds. The normal successful path uses three provider requests (plan, definition, engine). Transcript compaction, cache warming and automatic provider retries are disabled. No further provider call is allowed after a valid submission.
- Supervisor kills the child after five minutes, on excessive artifact output (220 KiB) or activity output (64 KiB), when a lease check reports cancellation/revocation, or after three consecutive failed lease checks (checked every five seconds, so one network blip does not abort a job). A worker lease expires after six minutes; expired jobs fail on the next queue/status access and are never automatically regenerated.
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

Protect database/WAL/backups: generation prompts, private source, lease digests and permission history are private. Retention is bounded and fail-closed; there is no automatic deletion or archive UI. Establish a retention/backup policy before reaching 500 jobs. SQLite retains only the current job artifact and bounded diagnostics, not hidden reasoning or intermediate source. If local operator tracing is enabled, its separately retained files include intermediate generated source and conversation/tool messages (but never private reasoning).

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

Worker tests exercise the real pi SDK with scripted provider streams: they assert the dedicated tool allowlist, complete and repair drafts, reject a 50-call flood before validation, cache duplicates, enforce stage-specific tools and retain accepted development work, block obsolete reference tools, handle malformed arguments and truncated responses, preserve provider/budget failure categories, redact diagnostics, and bound result-delivery retries. They also reject invalid/side-effectful source and enforce provider-request/context/output limits. No paid model calls are needed. Rust/browser tests cover permissions, consent, CSRF, separate credentials, private results, leases, cancellation/revocation, quotas, and generation → inert editor → explicit moderation submission. Container smoke testing has also passed with non-root/read-only/network-disabled settings and a scripted model. Scientific usefulness and live provider behavior still require operator-funded acceptance testing; automated tests are not proof of safe/scientifically correct future generations.
