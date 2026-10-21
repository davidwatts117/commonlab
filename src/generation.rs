//! Durable, opt-in generation queue. Workers never receive database or contributor credentials.
use crate::auth::{digest, random_hex};
use crate::submissions::{ApiError, Submission, SubmissionState, error, internal, no_cache};
use axum::{
    Json, Router,
    extract::{DefaultBodyLimit, Path, State},
    http::{HeaderMap, StatusCode, header},
    routing::{get, post},
};
use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use subtle::ConstantTimeEq;

#[derive(Clone)]
pub struct GenerationConfig {
    worker_token: String,
}
impl GenerationConfig {
    pub fn new(worker_token: String) -> std::io::Result<Self> {
        if !(32..=256).contains(&worker_token.len())
            || !worker_token
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || b"-_.".contains(&c))
        {
            return Err(std::io::Error::other(
                "GENERATION_WORKER_TOKEN must be 32–256 ASCII letters, digits, hyphens, underscores or dots",
            ));
        }
        Ok(Self { worker_token })
    }
    pub(crate) fn differs_from(&self, admin: Option<&str>) -> bool {
        Some(self.worker_token.as_str()) != admin
    }
}
pub fn router(state: SubmissionState) -> Router {
    Router::new()
        .route("/api/generation/config", get(config))
        .route("/api/generation/jobs", get(list).post(create))
        .route("/api/generation/jobs/{id}", get(detail))
        .route("/api/generation/jobs/{id}/cancel", post(cancel))
        .route("/api/generation/jobs/{id}/events", get(events))
        .route("/api/worker/generation/{id}/progress", post(progress))
        .route("/api/admin/generation/access", post(access))
        .route("/api/worker/generation/claim", post(claim))
        .route("/api/worker/generation/{id}/check", post(check))
        .route("/api/worker/generation/{id}/complete", post(complete))
        .route("/api/worker/generation/{id}/release", post(release))
        .layer(DefaultBodyLimit::max(256 * 1024))
        .layer(axum::middleware::map_response(no_cache))
        .with_state(state)
}
/// A job may only be touched by the worker holding its current lease.
const CURRENT_LEASE: &str = "SELECT j.simulation_id FROM generation_jobs j \
     JOIN contributors c ON c.id = j.contributor_id \
     WHERE j.id = ?1 AND j.status = 'running' AND j.lease_hash = ?2 AND c.generation_allowed = 1";
fn disabled() -> ApiError {
    error(
        StatusCode::SERVICE_UNAVAILABLE,
        "AI generation is not configured",
    )
}
fn require_enabled(state: &SubmissionState) -> Result<&GenerationConfig, ApiError> {
    state.generation.as_deref().ok_or_else(disabled)
}
fn worker(state: &SubmissionState, headers: &HeaderMap) -> Result<(), ApiError> {
    let config = require_enabled(state)?;
    let supplied = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.strip_prefix("Bearer "))
        .unwrap_or("");
    if !bool::from(config.worker_token.as_bytes().ct_eq(supplied.as_bytes())) {
        return Err(error(
            StatusCode::UNAUTHORIZED,
            "Worker authentication required",
        ));
    }
    Ok(())
}
fn expire(c: &Connection) -> Result<(), ApiError> {
    c.execute(
        "UPDATE generation_jobs SET status = 'failed', \
         error = 'Worker timed out; start a new request to retry.', \
         finished_at = unixepoch(), lease_hash = NULL \
         WHERE status = 'running' AND lease_expires <= unixepoch()",
        [],
    )
    .map_err(internal)?;
    Ok(())
}
fn lease_conflict() -> ApiError {
    error(
        StatusCode::CONFLICT,
        "Worker lease is expired, cancelled or no longer current",
    )
}
const ACTIVITY_CODES: &[&str] = &[
    "model_request",
    "reference_contract",
    "reference_schema",
    "validating",
    "validation_passed",
    "validation_failed",
    "finalized",
    "provider_error",
    "request_limit",
    "context_limit",
    "not_finalized",
    "timeout",
    "output_limit",
    "worker_error",
    "model_finished",
    "duplicate_draft",
    "tool_batch_rejected",
    "repairing",
    "provider_auth",
    "provider_rate_limit",
    "provider_unavailable",
    "output_truncated",
    "repair_limit",
    "no_progress",
    "tool_protocol",
    "configuration_error",
    "development_stage",
    "stage_completed",
    "tool_result",
    "draft_ready",
    "verifying",
    "visual_check_passed",
    "visual_check_failed",
    "review_started",
    "review_passed",
    "review_failed",
];
#[derive(Default, Deserialize, Serialize)]
#[serde(default, deny_unknown_fields, rename_all = "camelCase")]
struct Diagnostics {
    turn: Option<u32>,
    attempt: Option<u32>,
    requests: Option<u32>,
    context_bytes: Option<u32>,
    input_tokens: Option<u32>,
    output_tokens: Option<u32>,
    tool_calls: Option<u32>,
    validations: Option<u32>,
    duplicates: Option<u32>,
    max_tokens: Option<u32>,
    verification_rounds: Option<u32>,
    review_rounds: Option<u32>,
    tests: Option<u32>,
    tests_passed: Option<u32>,
    tests_failed: Option<u32>,
    canvases: Option<u32>,
    defects: Option<u32>,
    stop_reason: Option<String>,
    phase: Option<String>,
    tool: Option<String>,
    tool_status: Option<String>,
    issues: Vec<DiagnosticIssue>,
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct DiagnosticIssue {
    path: String,
    rule: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    line: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    column: Option<u32>,
}
impl Diagnostics {
    fn validate(&self) -> Result<(), ApiError> {
        let bad = || {
            error(
                StatusCode::UNPROCESSABLE_ENTITY,
                "Invalid bounded generation diagnostics",
            )
        };
        if [
            self.turn,
            self.attempt,
            self.requests,
            self.context_bytes,
            self.input_tokens,
            self.output_tokens,
            self.tool_calls,
            self.validations,
            self.duplicates,
            self.max_tokens,
            self.verification_rounds,
            self.review_rounds,
            self.tests,
            self.tests_passed,
            self.tests_failed,
            self.canvases,
            self.defects,
        ]
        .into_iter()
        .flatten()
        .any(|n| n > 10_000_000)
            || self.stop_reason.as_deref().is_some_and(|s| {
                ![
                    "stop", "length", "toolUse", "error", "aborted", "deferred", "unknown",
                ]
                .contains(&s)
            })
            || self
                .phase
                .as_deref()
                .is_some_and(|s| !["plan", "definition", "implementation"].contains(&s))
            || self.tool.as_deref().is_some_and(|s| {
                ![
                    "plan_simulation",
                    "define_simulation",
                    "submit_draft",
                    "review_critique",
                    "authoring_reference",
                    "unknown",
                ]
                .contains(&s)
            })
            || self
                .tool_status
                .as_deref()
                .is_some_and(|s| !["ok", "error", "blocked"].contains(&s))
            || self.issues.len() > 5
        {
            return Err(bad());
        }
        static PROPERTIES: std::sync::LazyLock<std::collections::HashSet<String>> =
            std::sync::LazyLock::new(|| {
                fn collect(value: &Value, names: &mut std::collections::HashSet<String>) {
                    match value {
                        Value::Object(map) => {
                            if let Some(Value::Object(props)) = map.get("properties") {
                                names.extend(props.keys().cloned());
                            }
                            for child in map.values() {
                                collect(child, names);
                            }
                        }
                        Value::Array(items) => {
                            for child in items {
                                collect(child, names);
                            }
                        }
                        _ => {}
                    }
                }
                let mut names =
                    std::collections::HashSet::from(["definition".into(), "moduleCode".into()]);
                let schema: Value =
                    serde_json::from_str(include_str!("../schema/simulation.schema.json"))
                        .expect("embedded schema");
                collect(&schema, &mut names);
                names
            });
        const RULES: &[&str] = &[
            "required",
            "type",
            "additionalProperties",
            "enum",
            "const",
            "minimum",
            "maximum",
            "minLength",
            "maxLength",
            "minItems",
            "maxItems",
            "pattern",
            "oneOf",
            "anyOf",
            "schema",
            "definition_size",
            "module_size",
            "assigned_id",
            "slot_ids",
            "range",
            "question_keys",
            "lesson_references",
            "cross_field",
            "javascript_syntax",
            "module_scope",
            "imports",
            "mount",
        ];
        for issue in &self.issues {
            if issue.line.is_some_and(|n| n == 0 || n > 1_000_000)
                || issue.column.is_some_and(|n| n > 1_000_000)
                || !RULES.contains(&issue.rule.as_str())
                || issue.path.len() > 180
                || !issue.path.starts_with('/')
                || issue.path.split('/').any(|s| {
                    !s.is_empty()
                        && s != "*"
                        && !PROPERTIES.contains(s)
                        && !(s.len() <= 5 && s.bytes().all(|c| c.is_ascii_digit()))
                })
            {
                return Err(bad());
            }
        }
        Ok(())
    }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Progress {
    lease: String,
    code: String,
    #[serde(default)]
    details: Diagnostics,
}
async fn progress(
    State(s): State<SubmissionState>,
    headers: HeaderMap,
    Path(id): Path<i64>,
    Json(input): Json<Progress>,
) -> Result<Json<Value>, ApiError> {
    worker(&s, &headers)?;
    if !ACTIVITY_CODES.contains(&input.code.as_str()) {
        return Err(error(
            StatusCode::UNPROCESSABLE_ENTITY,
            "Unknown activity code",
        ));
    }
    input.details.validate()?;
    let hash = digest(&input.lease);
    s.store.run(move |c| {
        let tx = c.transaction_with_behavior(TransactionBehavior::Immediate).map_err(internal)?;
        expire(&tx)?;
        tx.query_row(CURRENT_LEASE, params![id, hash], |_| Ok(())).optional().map_err(internal)?.ok_or_else(lease_conflict)?;
        tx.execute("INSERT INTO generation_events(job_id,code,details) SELECT ?1,?2,?3 WHERE (SELECT COUNT(*) FROM generation_events WHERE job_id=?1)<100", params![id, input.code, serde_json::to_string(&input.details).map_err(internal)?]).map_err(internal)?;
        tx.commit().map_err(internal)
    }).await?;
    Ok(Json(json!({"recorded":true})))
}
async fn events(
    State(s): State<SubmissionState>,
    headers: HeaderMap,
    Path(id): Path<i64>,
) -> Result<Json<Value>, ApiError> {
    let user = crate::auth::account(&s.store, &headers, s.secure_cookies).await?;
    let items = s.store.run(move |c| {
        c.query_row("SELECT id FROM generation_jobs WHERE id=?1 AND contributor_id=?2", params![id,user.id], |_| Ok(())).optional().map_err(internal)?.ok_or_else(not_found)?;
        let mut q = c.prepare("SELECT id,code,created_at,details FROM generation_events WHERE job_id=?1 ORDER BY id LIMIT 100").map_err(internal)?;
        q.query_map([id], |r| Ok(json!({"id":r.get::<_,i64>(0)?,"code":r.get::<_,String>(1)?,"createdAt":r.get::<_,i64>(2)?,"details":serde_json::from_str::<Value>(&r.get::<_,String>(3)?).unwrap_or_default()}))).map_err(internal)?.collect::<Result<Vec<_>,_>>().map_err(internal)
    }).await?;
    Ok(Json(json!({"items":items})))
}
async fn config(
    State(s): State<SubmissionState>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let user = crate::auth::account(&s.store, &headers, s.secure_cookies).await?;
    let allowed: bool = s
        .store
        .run(move |c| {
            c.query_row(
                "SELECT generation_allowed FROM contributors WHERE id=?1",
                [user.id],
                |r| r.get(0),
            )
            .map_err(internal)
        })
        .await?;
    let limits = s
        .store
        .run(|c| crate::limits::Limits::load(c).map_err(internal))
        .await?;
    Ok(Json(json!({
        "enabled": s.generation.is_some(),
        "allowed": allowed,
        "perDay": limits.generation_per_day,
        "globalPerDay": limits.generation_global_per_day,
        "maxPromptBytes": limits.generation_max_prompt_bytes,
    })))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Create {
    prompt: String,
    accept_provider_processing: bool,
}
async fn create(
    State(s): State<SubmissionState>,
    headers: HeaderMap,
    Json(input): Json<Create>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    require_enabled(&s)?;
    crate::auth::csrf(&headers)?;
    let user = crate::auth::account(&s.store, &headers, s.secure_cookies).await?;
    let limits = s
        .store
        .run(|c| crate::limits::Limits::load(c).map_err(internal))
        .await?;
    let max_prompt = usize::try_from(limits.generation_max_prompt_bytes).unwrap_or(8000);
    if !input.accept_provider_processing || input.prompt.trim().is_empty() {
        return Err(error(
            StatusCode::UNPROCESSABLE_ENTITY,
            "Provide a prompt and consent to provider processing",
        ));
    }
    if input.prompt.len() > max_prompt {
        return Err(error(
            StatusCode::UNPROCESSABLE_ENTITY,
            format!("Prompts are limited to {max_prompt} UTF-8 bytes; shorten the request"),
        ));
    }
    let slug = format!("ai-{}", &random_hex()?[..24]);
    let id = s
        .store
        .run(move |c| {
            let tx = c
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(internal)?;
            expire(&tx)?;
            let allowed: bool = tx
                .query_row(
                    "SELECT generation_allowed FROM contributors WHERE id = ?1",
                    [user.id],
                    |r| r.get(0),
                )
                .map_err(internal)?;
            if !allowed {
                return Err(error(
                    StatusCode::FORBIDDEN,
                    "A maintainer must grant AI generation access to this account",
                ));
            }
            let (total, day, personal, active, queue): (i64, i64, i64, i64, i64) = tx
                .query_row(
                    "SELECT COUNT(*), \
                     COALESCE(SUM(created_at >= unixepoch() - 86400), 0), \
                     COALESCE(SUM(contributor_id = ?1 AND created_at >= unixepoch() - 86400), 0), \
                     COALESCE(SUM(contributor_id = ?1 AND status IN ('queued','running')), 0), \
                     COALESCE(SUM(status IN ('queued','running')), 0) FROM generation_jobs",
                    [user.id],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
                )
                .map_err(internal)?;
            let limits = crate::limits::Limits::load(&tx).map_err(internal)?;
            if total >= limits.generation_retained_jobs
                || day >= limits.generation_global_per_day
                || personal >= limits.generation_per_day
                || active > 0
                || queue >= limits.generation_active_global
            {
                return Err(error(
                    StatusCode::TOO_MANY_REQUESTS,
                    "Generation capacity or quota reached; only one active request per contributor is allowed",
                ));
            }
            tx.execute(
                "INSERT INTO generation_jobs(contributor_id, prompt, simulation_id) VALUES (?1, ?2, ?3)",
                params![user.id, input.prompt.trim(), slug],
            )
            .map_err(internal)?;
            let id = tx.last_insert_rowid();
            tx.commit().map_err(internal)?;
            Ok(id)
        })
        .await?;
    Ok((
        StatusCode::ACCEPTED,
        Json(json!({"id":id,"status":"queued"})),
    ))
}
async fn list(
    State(s): State<SubmissionState>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let user = crate::auth::account(&s.store, &headers, s.secure_cookies).await?;
    let items = s
        .store
        .run(move |c| {
            expire(c)?;
            let mut q = c
                .prepare(
                    "SELECT id, status, created_at, finished_at, error, model, diagnostics FROM generation_jobs \
                     WHERE contributor_id = ?1 ORDER BY id DESC LIMIT 50",
                )
                .map_err(internal)?;
            q.query_map([user.id], |r| {
                Ok(json!({
                    "id": r.get::<_, i64>(0)?,
                    "status": r.get::<_, String>(1)?,
                    "createdAt": r.get::<_, i64>(2)?,
                    "finishedAt": r.get::<_, Option<i64>>(3)?,
                    "error": r.get::<_, String>(4)?,
                    "model": r.get::<_, String>(5)?,
                    "diagnostics": serde_json::from_str::<Value>(&r.get::<_, String>(6)?).unwrap_or_default(),
                }))
            })
            .map_err(internal)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(internal)
        })
        .await?;
    Ok(Json(json!({"items":items})))
}
async fn detail(
    State(s): State<SubmissionState>,
    headers: HeaderMap,
    Path(id): Path<i64>,
) -> Result<Json<Value>, ApiError> {
    let user = crate::auth::account(&s.store, &headers, s.secure_cookies).await?;
    let mut item = s
        .store
        .run(move |c| {
            expire(c)?;
            c.query_row(
                "SELECT prompt, simulation_id, status, artifact, error, model, diagnostics FROM generation_jobs \
                 WHERE id = ?1 AND contributor_id = ?2",
                params![id, user.id],
                |r| {
                    Ok(json!({
                        "id": id,
                        "prompt": r.get::<_, String>(0)?,
                        "simulationId": r.get::<_, String>(1)?,
                        "status": r.get::<_, String>(2)?,
                        "artifact": r.get::<_, Option<String>>(3)?,
                        "error": r.get::<_, String>(4)?,
                        "model": r.get::<_, String>(5)?,
                        "diagnostics": serde_json::from_str::<Value>(&r.get::<_, String>(6)?).unwrap_or_default(),
                    }))
                },
            )
            .optional()
            .map_err(internal)?
            .ok_or_else(not_found)
        })
        .await?;
    if let Some(text) = item["artifact"].as_str() {
        item["artifact"] = serde_json::from_str(text).map_err(internal)?;
    }
    Ok(Json(item))
}
fn not_found() -> ApiError {
    error(StatusCode::NOT_FOUND, "Generation request not found")
}
async fn cancel(
    State(s): State<SubmissionState>,
    headers: HeaderMap,
    Path(id): Path<i64>,
) -> Result<Json<Value>, ApiError> {
    crate::auth::csrf(&headers)?;
    let user = crate::auth::account(&s.store, &headers, s.secure_cookies).await?;
    s.store
        .run(move |c| {
            let tx = c
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(internal)?;
            let status: String = tx
                .query_row(
                    "SELECT status FROM generation_jobs WHERE id = ?1 AND contributor_id = ?2",
                    params![id, user.id],
                    |r| r.get(0),
                )
                .optional()
                .map_err(internal)?
                .ok_or_else(not_found)?;
            if !["queued", "running"].contains(&status.as_str()) {
                return Err(error(
                    StatusCode::CONFLICT,
                    "This request is already finished",
                ));
            }
            tx.execute(
                "UPDATE generation_jobs SET status = 'cancelled', finished_at = unixepoch(), \
                 lease_hash = NULL WHERE id = ?1",
                [id],
            )
            .map_err(internal)?;
            tx.commit().map_err(internal)
        })
        .await?;
    Ok(Json(json!({"id":id,"status":"cancelled"})))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Access {
    username: String,
    allowed: bool,
}
async fn access(
    State(s): State<SubmissionState>,
    headers: HeaderMap,
    Json(input): Json<Access>,
) -> Result<Json<Value>, ApiError> {
    s.authorize(&headers)?;
    let username = input.username.trim().to_ascii_lowercase();
    let value = s
        .store
        .run(move |c| {
            let tx = c
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(internal)?;
            let id: i64 = tx
                .query_row(
                    "SELECT id FROM contributors WHERE username = ?1",
                    [&username],
                    |r| r.get(0),
                )
                .optional()
                .map_err(internal)?
                .ok_or_else(|| error(StatusCode::NOT_FOUND, "Contributor not found"))?;
            tx.execute(
                "UPDATE contributors SET generation_allowed = ?1 WHERE id = ?2",
                params![input.allowed, id],
            )
            .map_err(internal)?;
            tx.execute(
                "INSERT INTO generation_access_events(contributor_id, allowed) VALUES (?1, ?2)",
                params![id, input.allowed],
            )
            .map_err(internal)?;
            if !input.allowed {
                tx.execute(
                    "UPDATE generation_jobs SET status = 'cancelled', finished_at = unixepoch(), \
                     lease_hash = NULL WHERE contributor_id = ?1 AND status IN ('queued','running')",
                    [id],
                )
                .map_err(internal)?;
            }
            tx.commit().map_err(internal)?;
            Ok(json!({"username":username,"allowed":input.allowed}))
        })
        .await?;
    Ok(Json(value))
}
async fn claim(
    State(s): State<SubmissionState>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    worker(&s, &headers)?;
    let raw = random_hex()?;
    let hash = digest(&raw);
    let result = s
        .store
        .run(move |c| {
            let tx = c
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(internal)?;
            expire(&tx)?;
            let running: bool = tx
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM generation_jobs WHERE status = 'running')",
                    [],
                    |r| r.get(0),
                )
                .map_err(internal)?;
            let next: Option<(i64, String, String)> = if running {
                None
            } else {
                tx.query_row(
                    "SELECT j.id, j.prompt, j.simulation_id FROM generation_jobs j \
                     JOIN contributors c ON c.id = j.contributor_id \
                     WHERE j.status = 'queued' AND c.generation_allowed = 1 ORDER BY j.id LIMIT 1",
                    [],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
                )
                .optional()
                .map_err(internal)?
            };
            let Some((id, prompt, slug)) = next else {
                tx.commit().map_err(internal)?;
                return Ok(Value::Null);
            };
            tx.execute(
                "UPDATE generation_jobs SET status = 'running', started_at = unixepoch(), \
                 lease_hash = ?1, lease_expires = unixepoch() + 360 WHERE id = ?2",
                params![hash, id],
            )
            .map_err(internal)?;
            tx.commit().map_err(internal)?;
            Ok(json!({"protocolVersion":1,"id":id,"prompt":prompt,"simulationId":slug,"lease":raw}))
        })
        .await?;
    Ok(Json(result))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Lease {
    lease: String,
}
async fn check(
    State(s): State<SubmissionState>,
    headers: HeaderMap,
    Path(id): Path<i64>,
    Json(input): Json<Lease>,
) -> Result<Json<Value>, ApiError> {
    worker(&s, &headers)?;
    let hash = digest(&input.lease);
    let active = s
        .store
        .run(move |c| {
            expire(c)?;
            c.query_row(CURRENT_LEASE, params![id, hash], |_| Ok(()))
                .optional()
                .map(|row| row.is_some())
                .map_err(internal)
        })
        .await?;
    Ok(Json(json!({"active":active})))
}
/// A stopping worker hands its job back to the queue, so a redeploy costs no one their quota.
async fn release(
    State(s): State<SubmissionState>,
    headers: HeaderMap,
    Path(id): Path<i64>,
    Json(input): Json<Lease>,
) -> Result<Json<Value>, ApiError> {
    worker(&s, &headers)?;
    let hash = digest(&input.lease);
    s.store
        .run(move |c| {
            let tx = c
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(internal)?;
            expire(&tx)?;
            tx.query_row(CURRENT_LEASE, params![id, hash], |_| Ok(()))
                .optional()
                .map_err(internal)?
                .ok_or_else(lease_conflict)?;
            tx.execute(
                "UPDATE generation_jobs SET status = 'queued', started_at = NULL, \
                 lease_hash = NULL, lease_expires = NULL WHERE id = ?1",
                [id],
            )
            .map_err(internal)?;
            tx.commit().map_err(internal)
        })
        .await?;
    Ok(Json(json!({"id":id,"status":"queued"})))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Complete {
    lease: String,
    artifact: Option<Artifact>,
    model: String,
    #[serde(default)]
    failure: Option<String>,
    #[serde(default)]
    diagnostics: Diagnostics,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Artifact {
    definition: Value,
    module_code: String,
}
async fn complete(
    State(s): State<SubmissionState>,
    headers: HeaderMap,
    Path(id): Path<i64>,
    Json(input): Json<Complete>,
) -> Result<Json<Value>, ApiError> {
    worker(&s, &headers)?;
    input.diagnostics.validate()?;
    if input.model.is_empty() || input.model.len() > 200 {
        return Err(error(
            StatusCode::UNPROCESSABLE_ENTITY,
            "Invalid worker model metadata",
        ));
    }
    if let Some(ref a) = input.artifact {
        crate::contributions::validate_input(
            &s,
            &Submission {
                definition: a.definition.clone(),
                engine_id: None,
                module_code: Some(a.module_code.clone()),
                submitted_by: String::new(),
            },
        )?;
    }
    let hash = digest(&input.lease);
    s.store
        .run(move |c| {
            let tx = c
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(internal)?;
            expire(&tx)?;
            let slug: String = tx
                .query_row(CURRENT_LEASE, params![id, hash], |r| r.get(0))
                .optional()
                .map_err(internal)?
                .ok_or_else(lease_conflict)?;
            let (status, artifact, message) = if let Some(a) = input.artifact {
                if a.definition["id"] != slug
                    || a.definition["assessment"]["id"]
                        .as_str()
                        .is_some_and(|id| id != slug)
                {
                    return Err(error(
                        StatusCode::UNPROCESSABLE_ENTITY,
                        "Generated simulation and bank must use the assigned ID",
                    ));
                }
                let bundle = json!({
                    "bundleVersion": 1,
                    "definition": a.definition,
                    "submittedBy": "",
                    "source": {"kind": "javascript", "moduleCode": a.module_code},
                });
                ("succeeded", Some(bundle.to_string()), "")
            } else {
                (
                    "failed",
                    None,
                    match input.failure.as_deref() {
                        Some("timeout") => "The agent exceeded the five-minute time limit. Try a smaller simulation.",
                        Some("output_limit") => "The generated output exceeded the size limit. Reduce the scope.",
                        Some("request_limit") => "The agent exhausted its model request budget before completing a valid draft.",
                        Some("context_limit") => "The agent exceeded its context budget. Try fewer requirements.",
                        Some("provider_error") => "The AI provider request failed. The operator should check model availability, credentials and billing.",
                        Some("provider_auth") => "The provider rejected authentication. Ask the operator to check the configured model key and permissions.",
                        Some("provider_rate_limit") => "The provider reported a rate, quota or billing limit. Ask the operator to check provider usage and credits.",
                        Some("provider_unavailable") => "The provider was unavailable or timed out. No automatic model retry was made.",
                        Some("output_truncated") => "The model twice exceeded its response-token limit. No incomplete tool calls were executed; try a smaller simulation.",
                        Some("repair_limit") => "The agent reached its draft repair limit. See the last validation diagnostics for the unresolved problems.",
                        Some("no_progress") => "The agent stopped making progress: it repeated an invalid draft or failed to submit usable changes.",
                        Some("tool_protocol") => "The model repeatedly violated the tool-call protocol. Batched draft submissions were blocked.",
                        Some("configuration_error") => "The generation model or worker configuration is invalid. Ask the operator to check it.",
                        Some("not_finalized") => "The agent stopped without finalizing a valid draft. Try a narrower, clearer request.",
                        _ => "The worker could not complete this request. Ask the operator to check worker health.",
                    },
                )
            };
            let diagnostics = serde_json::to_string(&input.diagnostics).map_err(internal)?;
            // Reserve terminal visibility even if an older worker filled the activity cap.
            tx.execute("DELETE FROM generation_events WHERE id=(SELECT MIN(id) FROM generation_events WHERE job_id=?1) AND (SELECT COUNT(*) FROM generation_events WHERE job_id=?1)>=100", [id]).map_err(internal)?;
            let terminal = if status == "succeeded" { "finalized" } else { input.failure.as_deref().filter(|code| ACTIVITY_CODES.contains(code)).unwrap_or("worker_error") };
            tx.execute("INSERT INTO generation_events(job_id,code,details) VALUES (?1,?2,?3)", params![id,terminal,diagnostics]).map_err(internal)?;
            tx.execute(
                "UPDATE generation_jobs SET status = ?1, artifact = ?2, error = ?3, model = ?4, \
                 finished_at = unixepoch(), lease_hash = NULL, diagnostics = ?6 WHERE id = ?5",
                params![status, artifact, message, input.model, id, diagnostics],
            )
            .map_err(internal)?;
            tx.commit().map_err(internal)
        })
        .await?;
    Ok(Json(json!({"id":id,"recorded":true})))
}
