# Generation redesign: lifecycle, verification, budgets and evidence

Status: approved and implemented in protocol 2. This document retains the original audit/proposal; [ai-generation.md](ai-generation.md) describes the shipped behavior. No deployment or paid inference was performed as part of the implementation.

## Incident: request #4 in commonlab-deploy-dev

Observed from the running deployment's job record and event history:

- started_at = 1792514605; finished_at = lease_expires = 1792514965.
- Exactly 360 seconds elapsed before the app recorded `Worker timed out; start a new request to retry.`
- The last event is author request 4, phase `implementation`, output budget 32768.
- There is no completed response for that request in the recorded timeline. This does not establish why the provider was slow or whether it would have completed.
- Worker container is running, reports no OOM kill and has restart count zero at inspection.

Confirmed source defect: `src/generation.rs::claim` grants a fixed six-minute lease. `check` checks but never renews it. The supervisor permits ten minutes. Expiry overwrites the job with a generic failure and no terminal activity event or diagnostic snapshot; subsequent completion is rejected as stale. The server can kill healthy work before the worker's own deadline. Raising the worker timeout without updating lease semantics introduced this regression.

## Other confirmed design defects

1. **False success:** after repair exhaustion, failed browser checks can fall through to finalization. Reviewer errors/skips can emit `review_passed`. Review-round count is not independently enforced.
2. **Incomplete budget:** author request counts omit reviewer calls. No unified token/cost ledger or per-model-call idle/total deadline. Output escalation is global across stages and not clamped to model limits or remaining context/time/budget.
3. **Lost work:** accepted plans, definitions, engines and tests exist only in child memory. Restart releases the job to start again; result-delivery exhaustion loses the local result.
4. **Weak diagnostics:** one best-effort activity delivery failure disables further activity; trace pipe accepts only the old event kinds, silently dropping verification/review records. Reviewer credentials are not included in the child trace redactor's known-secret list. Counters are overwritten by partial event snapshots; reasoning/cache/cost usage and reviewer usage are not accounted for coherently.
5. **Large all-or-nothing responses:** every engine submission repeats full engine source and tests in one JSON call. Truncation discards all of it; repair commonly repeats most of the artifact.
6. **Insufficient implementation references:** the prompt describes SimLib but supplies no complete compact engine API or verification API. The model is asked to use helpers whose signatures are not adequately grounded.
7. **Verification integrity:** empty cases and assertion-free modules count as passing; arbitrary module-returned booleans and a synthetic score count as tests. Agent tests and the engine share mutable browser state. There is no host-owned interaction matrix despite comments implying one, and no deterministic simulation-time API.
8. **Weak visual coverage:** only desktop, capped canvas sampling, screenshots after tests have mutated the scene, no named initial/interactive/reset states or mobile coverage. Screenshot labels are not reliably supplied with image attachments. Base64 images count toward the small serialized context cap.
9. **Cancellation/cleanup gaps:** the Chromium work timer is never cleared. Timeout racing does not itself cancel underlying work. Only the runner PID is killed; browser descendants need explicit teardown and an external kill fallback. Browser inherits process environment unless explicitly restricted.
10. **SDK coupling:** author and reviewer duplicate session setup and override agent internals. Scripted tests automatically bypass real verification, so green unit tests do not validate the production pipeline.
11. **Provider ambiguity:** models.json overlays a provider named `openrouter`, leaving built-in catalog behavior in play. Unknown-ID tests alone do not establish a strict explicit-model allowlist.

## Design principles

- Keep the existing Axum queue, a single worker deployment, pi SDK and bundled Chromium. No new queue service, orchestration framework or Docker socket.
- One host-owned typed state machine; models create artifacts and findings, never choose final status.
- Separate deterministic evidence, agent-authored assertions, and model judgments. None is a security or scientific proof.
- Save validated work before spending on the next step. Never silently turn missing verification into success.
- One limits policy and one usage ledger for all model roles and retries.
- Small, resumable artifact operations rather than giant repeatedly serialized draft calls.
- Contributor-safe status and reports; raw prompts/transcripts/screenshots remain private. No private reasoning is persisted.

## Proposed end-to-end lifecycle

`queued -> preflight -> design -> build -> verify -> review -> repair -> verify -> [review] -> complete`

Each stage records its start/end, input artifact hash, outcome and elapsed time. Repair is bounded to two review cycles plus a separate deterministic-validation repair allowance, all inside a shared job budget. A repaired artifact always receives fresh deterministic verification. Review evidence is bound to an exact artifact hash; stale evidence cannot approve changed code.

### 1. Preflight before claiming paid work

- Check static model config for author and reviewer, API URL/type, output limits, credentials present, required vision capability, local assets, writable private checkpoint storage and Chromium launch/render self-test.
- Use an explicitly named custom OpenAI-completions provider (e.g. `commonlab-openrouter`) pointing only at `https://openrouter.ai/api/v1`; use exactly the configured model entries. Preserve existing operator-facing settings through a single documented mapping. No model-name guessing or runtime metadata fallback.
- Validate model capability metadata against OpenRouter using an operator command / deployment check, not a paid job dependency. Store check time and config hash; do not log keys. Missing vision configuration is an explicit preflight error for the normal verified mode.
- Expose readiness separately from process liveness. Preflight validates configuration, not provider billing or actual inference availability.

### 2. Design, then a constrained artifact workspace

- Keep one concise design stage producing equations, assumptions, declared state/control contract, definition and required checks. Let schema failures repair this stage without restarting the job. Avoid another redundant planning agent.
- Supply a tested compact SimLib reference, one working engine example, closed definition schema and complete verification API. Keep reference blocks stable for provider caching.
- Build with allowlisted workspace tools: read named artifacts, write a named artifact, apply exact edits against an expected hash, run verification, inspect a named screenshot. No shell, arbitrary filesystem, packages, network or publication tools.
- Workspace has fixed artifacts: definition.json, engine.js and author tests. Writes are bounded and atomic. Expected-hash edits prevent accidental stale changes. Engine helper chunks can be assembled in the fixed module rather than resending all source each turn; final module restrictions remain unchanged.
- Preserve complete validated artifacts, not incomplete tool-call JSON. Keep a previous usable snapshot on invalid edits. Engine and test generation are separable so neither must fit in one huge response.
- Use a shared SDK adapter for author/reviewer with documented session APIs. Confine any version-specific hooks behind that adapter and test them against the exact locked pi/SDK dependency tree. Do not combine an SDK upgrade with the redesign.

### 3. Deterministic verification before paid review

- Verification runs in a dedicated disposable child process inside the existing worker container, with a credential-free explicit environment, no app cookies, private data mounts or operator endpoints. Static allowlisted shell assets only; opaque-origin sandbox for generated code; deny external requests, popups/downloads and unexpected local routes. Browser sandbox use should be tested under current container restrictions; do not claim no-sandbox Chromium is a security boundary.
- Keep bundled Chromium: no runtime browser downloads, extra evaluation service or Docker socket. Container remains the outer boundary. Verify process-tree cleanup under cancellation and stuck synchronous JavaScript.
- Independent watchdog can kill the browser process group even if page JavaScript or teardown hangs. Clear all timers, bound startup/run/cleanup separately and close server connections explicitly.
- Host-owned smoke suite: mount/animation/reset, runtime errors, declared-slot access, actual interaction listeners and bounded control exploration, finite observable state, desktop/mobile layout, theme checks and declared lesson adapter checks. A control changing its own input value does not prove simulation behavior changed.
- Capture labeled evidence in fresh initial, meaningful changed-control and reset states. Enforce screenshot count/pixel/byte budgets; include viewport and artifact hash. Blank-canvas metrics are warnings/evidence, not a proof of a useful scene.
- Add a small deterministic adapter for step(dt), reset and inspectState so physics tests do not depend on wall-clock animation. Supply an example and keep optional scientific state fields explicit rather than inventing universal physics assertions.
- Run author manifest checks and sandboxed JS tests on fresh instances. Host records assertion calls and expected/actual values; no synthetic score, caller-supplied pass count, silent case slicing, empty-case passes or swallowed reset failures. Strict schemas and limits reject malformed tests.
- Persist the initial required test set across repairs. Changes to expected results are visible in the report; deleting a failing test cannot count as fixing the artifact.
- Infrastructure failures retry the harness once when safe; they do not ask the author to change physics code. Deterministic engine failures produce targeted repair feedback.

### 4. Independent adversarial review

- Reviewer sees original requirements, scientific contract, exact source, host checks, test coverage and labeled screenshots. Keep contributor content untrusted; do not silently truncate requirements or source.
- Reviewer must inspect visual evidence and file structured evidence-backed defects with stable IDs, severity and suggested regression tests. It may propose tests run by the same bounded harness; a second model's verdict is not trusted execution evidence.
- Author receives findings and may fix or explicitly rebut each. Retain the rebuttal for human review; no requirement to blindly obey a hallucinated criticism. No more than two review rounds.
- No review on a demonstrably broken engine unless needed for diagnosis. Review passes, unavailable review and advisory concerns are separate outcomes.
- Terminal policy: `succeeded` only after required host checks and required review complete. Minor/advisory findings can accompany success. Unresolved scientific/visual major findings after bounded repair yield `needs_attention`, with private candidate and exact findings retained. Required runtime/check failures cannot become success. A reviewer outage yields `review_unavailable`, not pass; reviewer-only retry need not regenerate the engine.
- Human publication review is always required.

## Lifecycle reliability and persistence

- Replace check-only polling with an authenticated heartbeat transaction: renew only the current attempt's unexpired lease, respect cancellation/access revocation, never resurrect terminal jobs.
- Separate three concepts: short renewable liveness lease (initial proposal: 90 s TTL, 15 s heartbeat), stage deadlines, and absolute job deadline (initial proposal: 12 min). Server returns deadline/budget policy when claiming; worker does not invent an unrelated limit. Reserve time for checkpoints, cleanup and delivery. Heartbeats never extend the absolute deadline.
- Every attempt has a fencing token/attempt ID. Conditional checkpoint and complete writes reject stale workers. Use idempotent event IDs and completion keys; retain receipt so retries after lost HTTP responses are safe.
- Store bounded private operational checkpoints (accepted design, artifact/test snapshots and reports) separately from optional transcript tracing. Worker-only persistent volume + server-recorded hashes/stage metadata suffice initially; keep single-worker resume on that deployment explicit. Do not promise cross-host recovery without a shared artifact store.
- Checkpoint after each accepted operation; spool completion before delivery. On restart resume at the checkpoint and reverify if necessary, not from the original prompt. Never replay an in-flight request automatically as if its charge/output were known.
- Bounded retries with jitter for transient 429/5xx/network faults, honoring Retry-After and remaining deadlines. No retries for authentication, schema/program errors or ambiguous completed operations without idempotency. Record uncertainty of in-flight provider billing.
- Expiry/cancellation/revocation/deadline/OOM/provider stall each produce a distinct terminal cause with the last stage and counters. Expiry writes a terminal event and preserves prior diagnostics; do not erase model identity or useful work.

## Performance and cost policy

Initial values are tuning hypotheses, not promises. Measure a small acceptance corpus before making them defaults.

- Typical path: one design call, bounded artifact build operations, host verification, one reviewer call. At most two review rounds. All model calls share one ledger including retries and author/reviewer roles.
- Prefer small target outputs (design ~4k, code operation ~8–16k, review ~4k) over unconditional 32–65k tool calls. Clamp to model output/context limits, remaining tokens, estimated cost and remaining wall time. Truncation retries once at a larger local operation budget, then split/reduce that operation, not blindly double every future stage.
- Per-call initial-response timeout, streaming-idle timeout and total timeout are independent. Starting hypotheses: 45 s first response, 45 s idle, 180 s total; adjust per configured model using observed latency. Progress is streamed as byte/token activity without exposing reasoning.
- Configure total input/output ceilings and estimated USD budget per job, with per-call worst-case reservation; account for image, cache and reasoning usage where reported. Missing/variable pricing and provider post-disconnect charges mean this is not a guaranteed dollar cap. Retain provider-side spending limits.
- Stable references, compact failure reports and hash-addressed screenshots avoid replaying every prior draft/test and large base64 image multiple times. Budget text tokens and image payload separately.
- One browser per verification subprocess, fresh contexts for cases; compare artifact hashes to avoid rerunning unchanged successful checks. Reuse a passing report only for the identical artifact/test/harness version.

## Observability and user experience

- One versioned event schema shared/generated across Rust and JS, not multiple hand-maintained allowlists. Include job/attempt/call IDs, role, stage, artifact hash, monotonic durations, deadline remaining, retry cause, output budget, usage/cost and verification coverage.
- Emit call started, first response, coalesced streaming progress, call finished, stage finished, retry scheduled and terminal outcome. Show last activity age, current stage elapsed and budget remaining. No invented percentage completion.
- Heartbeat runs independently from progress delivery. Progress delivery uses a bounded retry queue and explicit dropped-event counters, never permanently disables itself after one network blip. Coalesce repetitive events and reserve terminal capacity.
- Contributor UI receives safe structured summaries: e.g. `Engine request stalled for 45 s; retrying once`, `Lease lost`, `Browser failed to start`, `2 checks failed`, `Review unavailable`. Reports retain check names, actual/expected values where safe, unresolved findings and snapshot versions. No operator credentials or raw provider responses.
- Operator logs include redacted structured causes and request IDs even when full trace recording is disabled. Optional private JSONL traces retain completed prompts/tool messages and evidence references, never private reasoning. Add both provider keys to redaction; one complete event path must retain verification/review events.
- Keep screenshots and raw traces private operator-local artifacts per existing preference; contributor reports do not expose transcripts/downloads. Operational checkpoint retention is separately documented and bounded.

## Implementation sequence (approved)

1. **Lifecycle correctness:** heartbeat + absolute deadline + fencing + terminal causes + unified limits/event schema. Regression test the exact six-versus-ten-minute failure using fake clocks. Fix misleading status paths immediately in this slice.
2. **Shared model adapter and budget ledger:** explicit provider allowlist, preflight, per-call cancellation/deadlines, streaming telemetry, reviewer accounting and safe retry policy.
3. **Checkpointed build workspace:** compact tested references, bounded artifact operations, hashes, restart/resume and durable result delivery. Remove the giant submit-and-restart repair transport.
4. **Verifier isolation and evidence integrity:** credential-free process/watchdog, host smoke matrix, deterministic adapter, strict tests, fresh state, desktop/mobile screenshots and proper cancellation/cleanup.
5. **Reviewer and end-to-end UI:** evidence-bound findings, mandatory repair/rebuttal, two-round bound, truthful terminal outcomes and private candidate recovery.
6. **Acceptance and rollout:** scripted fault matrix, real locked-image smoke test, opt-in paid benchmark, then dev deployment first. Upgrade app/worker together with a protocol handshake; no production cutover before operator approval.

## Required acceptance tests

- Healthy job runs past six minutes with heartbeats; hard deadline still stops it; stale workers cannot renew/write; cancellation and revocation stop promptly.
- Lost heartbeat response, repeated network loss, dropped progress, duplicate checkpoint/complete, restart during each stage and result-delivery outage preserve truthful state and bounded spending.
- Provider no-first-response, mid-stream stall, transient 429/503, auth failure, truncated JSON, oversized artifact, malformed call and reviewer-only outage have distinct deterministic outcomes.
- Infinite mount/test loop, hung browser cleanup, missing browser/assets, repeated cases, empty assertions, deleted failing tests, mobile overflow and frozen scene fail correctly without leaving descendants or credentials exposed.
- Required verification failure never yields success; unavailable reviewer never yields pass; evidence for an older hash cannot approve a new artifact.
- Tests always inject verifier/reviewer behavior explicitly; a scripted model stream must not silently disable production verification.
- Execute the complete worker inside its actual non-root/read-only/cap-dropped image; check no external browser network, no secrets, correct restart/resume and no orphan processes.
- Paid acceptance set includes the user's collision lab, an oscillation lab, a chemistry lab and deliberately broken specimens. Measure verified-success rate, latency p50/p95, token/cost totals, repairs, timeout categories and reviewer false positives. Compare to the current baseline; publish measurements without claiming scripted tests establish real model quality.

## Implementation adjustments and remaining acceptance work

- `needs_attention` is an API outcome backed by the existing terminal failed state plus an additive outcome column; this avoids rebuilding SQLite's constrained jobs table.
- Interrupted inference is not auto-replayed. Between-operation checkpoints resume; an ambiguous charged request returns an explicit `inference_interrupted` outcome with reservations and artifacts retained.
- Review rebuttals use a typed `respond_review` tool and remain in the owner report; they are not hidden model reasoning.
- The current pinned SDK does not expose reliable Retry-After headers through this adapter. Recovery is one bounded jittered retry for safe transient failures, with no auth/quota/billing replay; there is no claimed exact Retry-After support.
- Verifier snapshots are recaptured on resume rather than persisting screenshot blobs in operational checkpoints. Required tests are retained, and artifact/harness hashes bind reports to their inputs. Unchanged verification is not yet cached across separate runs.
- Reviewers suggest regression checks in their findings; an independent reviewer-authored executable test tool is not included in this slice. Author manifests/modules and host-owned checks execute with strict bounds and fresh state.
- The harness does not exercise complete guided lessons/assessments. Verified generation now explicitly requires empty lessons and no assessment rather than silently approving untested learning flows. The manual editor and published existing lessons are unchanged.
- Scientific state and layout checks are deterministic; browser pixel heuristics are deliberately modest. They do not establish animation usefulness, accessibility completeness or scientific correctness. Vision review and human publication review remain necessary.
- Multi-host failover, a contributor retry/resume UI, operator recovery UI and paid model benchmarking remain out of scope. The supported deployment is one worker with one private persistent checkpoint volume.
- The deployment acceptance gate includes real SDK scripted tests and real Chromium in the locked, hardened image. Real latency/cost/quality measurements still require an explicitly approved paid corpus run.

## Validation performed

- Rust test suite, `cargo fmt --check`, and clippy with warnings denied: passed.
- Root JavaScript unit tests: 47 passed.
- Application browser tests: 23 passed, including private unverified candidate display/import without executing its source.
- Pinned worker image, UID 10001, read-only filesystem, no capabilities/new privileges, network disabled, 128 PID / 2 CPU / 2 GiB limits: all 48 worker tests passed with no skips. This includes real Chromium, external infinite-loop termination, startup protocol handshake, private operational recovery, and a lost completion response retried without inference.
- Explicit worker dependency declarations: checked with Knip/TypeScript 5.9.3 (the initial standalone Knip invocation had an incompatible transient TypeScript resolution; the compatible invocation passed).
- OpenRouter's public metadata endpoint currently confirms image input for all four configured models. No inference calls were used for this check.
- No live deployment, production database migration, paid inference or model-quality benchmark was performed. Those remain separate acceptance/deployment steps.

## Scope and approval

This is a focused replacement of the worker orchestration/verification pipeline, not another timeout increase. Preserve existing accounts, permissions, quotas, manual editing, SQLite drafts and human publication flow. Migrations are additive and existing completed artifacts remain readable. Candidate/checkpoint retention, the initial budget profile and new `needs_attention` outcome are explicit parts of the approval scope.
