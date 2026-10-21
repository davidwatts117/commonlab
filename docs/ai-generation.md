# Verified, checkpointed simulation generation

Generation remains opt-in: maintainers grant individual accounts access at `/review.html`. Contributors consent to provider processing for each request. Results are private inert drafts, never automatic publications. Permission checks, quotas, ownership, leases and publication review remain owned by Axum/SQLite.

## Workflow

1. **Preflight before claiming a job:** validate the explicit author/reviewer models and credentials, require an image-capable reviewer, check private checkpoint storage, and run a real Chromium shell self-test. A bad deployment does not claim paid work. The worker becomes healthy only after this succeeds.
2. **Design:** one compact model call supplies equations, assumptions, required checks and the closed UI definition. Verified generation currently covers engines, controls, cards and graphs; it requires empty lessons and no assessment because the harness does not exercise the complete guided-learning flow. Those can be added later in the manual editor. The host validates the definition and assigns IDs.
3. **Build/repair:** allowlisted tools read up to 200 lines, replace/append or exact-edit one of `definition.json`, `engine.js`, `tests.json`, `tests.js`. Writes require the current hash and size bounds. Accepted operations are durably checkpointed. No shell, arbitrary filesystem, downloads, installation, model discovery or publication tools exist.
4. **Verify:** static schema/source checks first, then a separate credential-free Chromium subprocess runs host smoke checks, the agent's tests on fresh engine instances, fixed-step scientific state checks, desktop/mobile layouts and labeled visual capture. An external watchdog kills hung engine/browser code and descendants. Passing booleans returned by agent code do not count as assertions. Empty or malformed tests fail. Existing test cases and modules remain required across repairs.
5. **Independent vision review:** a separate session sees the original requirements, scientific contract, exact artifact, check report and labeled screenshots. It files evidence-backed major/minor findings. Author corrections or explicit evidence-backed rebuttals must address each major finding before reverification. Two review rounds maximum.
6. **Finalize:** success requires passing required verification and completed review for the same artifact hash. Unresolved checks, missing review or exhausted repairs never become success. A syntactically validated candidate is retained as `needs_attention` for manual editing; this is not a verified result. Human review is always required to publish.

`docs/generation-engine-api.md` is the actual compact reference supplied to the author, including a working SimLib example, finite `inspectState()` contract, fixed-step test API and workspace operations. The engine still exports synchronous `mount(ui)` and ships as one self-contained module. UI templates remain closed-schema data. Generated scientific assertions and reviewer findings are evidence, not a proof of safety or scientific correctness.

## Provider and SDK

The worker pins `@earendil-works/pi-coding-agent` **1.2.0**; the lockfile currently resolves pi-ai **1.3.0**. SDK access is isolated in `worker/model-call.mjs`. No ambient pi credentials, settings, AGENTS files, sessions, extensions, MCP, skills, telemetry or automatic provider retries are loaded.

`worker/models.json` declares the distinct custom provider `commonlab-openrouter`, using `openai-completions` at `https://openrouter.ai/api/v1`. Existing `CL_MODEL_PROVIDER=openrouter` maps to that name. Only explicitly listed models can be selected; pi's built-in OpenRouter catalog cannot silently supply another model. No runtime name guessing or capability fallback occurs. Run `npm run check:models --prefix worker` as an operator to check the listed IDs/image modalities against the public OpenRouter API without an inference call. This is not a paid-job dependency or authentication/billing check.

Set both an author model and a vision reviewer model. The reviewer key defaults to the author key when empty. Screenshot review is required; `CL_REVIEW_IMAGES=0` fails preflight rather than silently weakening verification. `CL_AUTHOR_IMAGES=0` can disable images in author repair prompts while keeping reviewer vision required. Changing model metadata requires a worker rebuild and should be checked against OpenRouter first.

## Deadlines, retries and budgets

`schema/generation-protocol.json` is embedded by Rust and read by the worker. Claim includes its version, policy, attempt number, absolute deadline and random lease. An authenticated startup handshake checks app/worker version and policy before claiming any work. Mismatches fail readiness before inference.

- Heartbeat every **15 s**, renewable lease **90 s**, absolute job deadline **12 min**. Renewal is a transaction that checks current lease, deadline, permission and job state. It cannot resurrect expired/cancelled/revoked work. Heartbeats also save the latest safe diagnostics independently of activity delivery.
- First model response **45 s**, streaming idle **45 s**, call total **180 s**. Streaming activity is counted but private reasoning is never retained. A **10 s delivery/cleanup reserve** is withheld from inference. Browser verification watchdog: **60 s** per attempt, including startup and teardown.
- One ledger covers author, reviewer and retries: at most **14 provider requests**, **200k input tokens**, **60k output tokens**, and **$2 estimated/reserved cost** per job. These initial tuning values are in the shared policy, not duplicated across services.
- Small operation budgets: design 5k, build operation 12k, reviewer 4k tokens; clamp to model limits, remaining context/tokens and cost. Truncation retries the current operation once up to 16k with instructions to split it, not unbounded global output escalation. No incomplete operation executes.
- Transient provider failures can receive one bounded jittered retry before partial streaming; authentication, quota/billing failures and programming/schema errors are not blindly retried. The SDK does not reliably expose provider Retry-After headers through this adapter, so it does not claim precise header-aware backoff. No automatic model switching.
- Up to **3 deterministic verification repair attempts** and **2 review rounds**, inside the same request/cost/deadline ledger. Infrastructure verification failures retry the harness once, without asking the author to rewrite physics.

Cost is an estimate from configured per-million-token prices and reported usage; reservations are checkpointed **before** each call. Ambiguous interrupted requests retain their reservation. Images, dynamic pricing and provider charges after disconnect prevent a guaranteed dollar cap: keep provider-side project/key spending limits enabled.

## Recovery and delivery

A worker-only named volume at `/var/lib/commonlab/checkpoints` stores private operational state, distinct from optional transcripts. Files use mode 0600 inside a nonsymlinked 0700 directory. Updates use atomic rename, file sync and directory sync; identity hashes bind state to the job ID, requirements and simulation ID. Stored work includes accepted design, named artifacts, baseline tests, ledger, exact evidence hashes, responses to review and a completion outbox. Screenshots/transcripts are not stored in SQLite.

The supervisor's private assignment file retains the current lease and runner PID/start identity. Before recovery it stops a recorded orphan only if the process identity still matches, avoiding PID-reuse kills. The worker token and assignment/lease are never given to the model runner or browser. Graceful shutdown kills the runner group, releases the lease and preserves checkpoints and the original absolute deadline. A later claim receives a fresh lease/attempt; stale workers cannot commit.

- Restart between complete artifact operations resumes from saved work. Completed tool arguments are checkpointed together with usage before execution; a crash between the model response and artifact application replays the operation, not inference.
- Restart during verification/review recaptures browser evidence before further review.
- Restart **during inference** stops as `inference_interrupted`: usage/output may be unknown, so the potentially paid request is not silently repeated. Saved artifacts and the conservative reservation remain. This is an intentional correctness/cost trade-off, not seamless replay.
- Completion is spooled before delivery. Identical completion retries are idempotent even after a lost HTTP response; conflicting/stale completions are rejected. A delivery outage does not regenerate the simulation. Permanent server artifact-validation rejection is retained privately and delivered as a failure rather than resubmitted forever.
- Heartbeat loss and absolute deadline expiry produce distinct terminal events and preserve last diagnostics. Catastrophic expiry/cancellation can prevent candidate delivery to the app; the private checkpoint is still available to the operator, not an automatic retry authorization.

This implementation supports **one worker instance and one persistent checkpoint volume on one deployment**. Do not share that volume across multiple live supervisors/hosts. Cross-host artifact storage, automatic failover and an operator resume/recover UI are not implemented. Operational checkpoints are pruned on supervisor startup to seven days/500 files; protect the volume and backups. Optional transcript retention is separate.

## Observability and privacy

The owner sees current stage/role, time and budget remaining, last heartbeat age, output budget, shared request/usage/cost counters, safe retry causes, required test failures and reviewer findings. Private candidates can be opened as inert text in the manual editor with a visible unresolved-check warning. Nothing auto-executes or bypasses moderation.

Activity events have retry-safe IDs; the bounded queue retries delivery after failures instead of disabling itself. Streaming updates are sampled per call, the timeline is capped at 100 events, and a terminal slot is reserved. Latest diagnostics also travel via heartbeat, so timeline limits do not freeze current-stage information. Ordinary worker logs contain safe structured job/attempt/code/counter records, not prompts, source, credentials, raw provider errors or reasoning.

`CL_AGENT_TRACE_DIR` optionally enables operator-only JSONL transcripts as before. The trace pipe now retains verification and review records as well as model messages. Both author and reviewer credentials are redacted. Private thinking/reasoning blocks and signatures are omitted. Trace write failure must not abort generation. Traces have no public/API endpoint or contributor downloads; protect their private volume. Defaults: 50 files, 8 MiB per file, seven days, configurable through `CL_AGENT_TRACE_MAX_FILES`, `CL_AGENT_TRACE_MAX_BYTES`, `CL_AGENT_TRACE_MAX_DAYS`.

## Deployment and trust boundaries

Upgrade app and worker together after backing up SQLite; migration **9** is additive and preserves existing jobs/publications. Existing worker protocol 1 cannot claim jobs from protocol 2. The `needs_attention` API outcome is stored using the existing terminal `failed` storage state plus an explicit outcome field, avoiding a risky table/check-constraint rebuild.

The official pinned Playwright image contains the matching Chromium, so builds do not download a browser from cdn.playwright.dev. Keep the worker non-root/read-only, cap-dropped/no-new-privileges, with no Docker socket, no application database/cookie/admin-token mounts, 2 CPU/2 GiB and 512 MiB `/tmp`. Compose mounts only worker trace and checkpoint volumes. The readiness healthcheck appears only after preflight. Local process execution is supported for tests; production isolation depends on the container.

Generated engine and JS tests execute only in an opaque-origin frame, with restricted local assets and denied external requests, storage, popups/downloads and app access. The browser subprocess receives a credential-free environment. Chromium currently uses `--no-sandbox` under the existing container restrictions: **the container remains the outer security boundary**, not a guarantee against browser exploitation. Keep browsers/dependencies patched; do not treat a simulation test as a sandbox security proof. Firewall egress to the app and chosen provider for the worker; the Compose bridge is not an egress allowlist.

## Verification commands

```sh
cargo fmt --check
cargo clippy --all-targets -- -D warnings
cargo test
node --test tests/*.test.mjs
npm ci --prefix worker --ignore-scripts
npm test --prefix worker
npm run test:verification --prefix worker
npm run test:browser
```

Set `PLAYWRIGHT_CHROMIUM_EXECUTABLE` for an installed browser when necessary. Unit tests explicitly inject scripted model/verifier behavior; providing a scripted model no longer implicitly disables production verification. Browser verification tests run separately and cover real assertions, false-pass modules, fresh state, NaN, opaque-origin storage/network denial, desktop/mobile rendering, mount failure, missing browser and synchronous infinite loops. Rust tests cover the exact >6-minute renewal regression, absolute deadlines, stale tokens, deduplicated events, truthful candidate outcomes, permissions and idempotent completion. Tests require no paid inference.

Use an opt-in paid acceptance corpus (collision lab, oscillator, chemistry lab, deliberately broken examples) to tune real model latency, cost and success rate. Passing scripted/browser tests is not evidence of live model quality; paid benchmarks and production deployment require operator approval.
