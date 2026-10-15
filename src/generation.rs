//! Durable, opt-in generation queue. Workers never receive database or contributor credentials.
use crate::submissions::{ApiError, Submission, SubmissionState, error, internal, no_cache};
use axum::{
    Json, Router,
    extract::{DefaultBodyLimit, Path, State},
    http::{HeaderMap, StatusCode, header},
    routing::{get, post},
};
use rand_core::{OsRng, RngCore};
use rusqlite::{Connection, OptionalExtension, params};
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
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
        .route("/api/admin/generation/access", post(access))
        .route("/api/worker/generation/claim", post(claim))
        .route("/api/worker/generation/{id}/check", post(check))
        .route("/api/worker/generation/{id}/complete", post(complete))
        .layer(DefaultBodyLimit::max(256 * 1024))
        .layer(axum::middleware::map_response(no_cache))
        .with_state(state)
}
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
fn random() -> Result<String, ApiError> {
    let mut b = [0u8; 32];
    OsRng.try_fill_bytes(&mut b).map_err(internal)?;
    Ok(b.iter().map(|b| format!("{b:02x}")).collect())
}
fn digest(s: &str) -> String {
    format!("{:x}", Sha256::digest(s.as_bytes()))
}
fn expire(c: &Connection) -> Result<(), ApiError> {
    c.execute("UPDATE generation_jobs SET status='failed',error='Worker timed out; start a new request to retry.',finished_at=unixepoch(),lease_hash=NULL WHERE status='running' AND lease_expires<=unixepoch()",[]).map_err(internal)?;
    Ok(())
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
    Ok(Json(
        json!({"enabled":s.generation.is_some(),"allowed":allowed,"perDay":3,"globalPerDay":20,"maxPromptBytes":8000}),
    ))
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
    if !input.accept_provider_processing
        || input.prompt.trim().is_empty()
        || input.prompt.len() > 8000
    {
        return Err(error(
            StatusCode::UNPROCESSABLE_ENTITY,
            "Provide a prompt of 1–8000 UTF-8 bytes and consent to provider processing",
        ));
    }
    let slug = format!("ai-{}", &random()?[..24]);
    let id=s.store.run(move|c| {
        let tx=c.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate).map_err(internal)?;expire(&tx)?;
        let allowed:bool=tx.query_row("SELECT generation_allowed FROM contributors WHERE id=?1",[user.id],|r|r.get(0)).map_err(internal)?;
        if !allowed {return Err(error(StatusCode::FORBIDDEN,"A maintainer must grant AI generation access to this account"));}
        let (total,day,personal,active,queue):(i64,i64,i64,i64,i64)=tx.query_row("SELECT COUNT(*),COALESCE(SUM(created_at>=unixepoch()-86400),0),COALESCE(SUM(contributor_id=?1 AND created_at>=unixepoch()-86400),0),COALESCE(SUM(contributor_id=?1 AND status IN ('queued','running')),0),COALESCE(SUM(status IN ('queued','running')),0) FROM generation_jobs",[user.id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?))).map_err(internal)?;
        if total>=500||day>=20||personal>=3||active>0||queue>=10 {return Err(error(StatusCode::TOO_MANY_REQUESTS,"Generation capacity or quota reached; only one active request per contributor is allowed"));}
        tx.execute("INSERT INTO generation_jobs(contributor_id,prompt,simulation_id) VALUES (?1,?2,?3)",params![user.id,input.prompt.trim(),slug]).map_err(internal)?;
        let id=tx.last_insert_rowid();tx.commit().map_err(internal)?;Ok(id)
    }).await?;
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
    let items=s.store.run(move|c| {expire(c)?;let mut q=c.prepare("SELECT id,status,created_at,finished_at,error,model FROM generation_jobs WHERE contributor_id=?1 ORDER BY id DESC LIMIT 50").map_err(internal)?;
        q.query_map([user.id],|r|Ok(json!({"id":r.get::<_,i64>(0)?,"status":r.get::<_,String>(1)?,"createdAt":r.get::<_,i64>(2)?,"finishedAt":r.get::<_,Option<i64>>(3)?,"error":r.get::<_,String>(4)?,"model":r.get::<_,String>(5)?}))).map_err(internal)?.collect::<Result<Vec<_>,_>>().map_err(internal)
    }).await?;
    Ok(Json(json!({"items":items})))
}
async fn detail(
    State(s): State<SubmissionState>,
    headers: HeaderMap,
    Path(id): Path<i64>,
) -> Result<Json<Value>, ApiError> {
    let user = crate::auth::account(&s.store, &headers, s.secure_cookies).await?;
    let mut item=s.store.run(move|c| {expire(c)?;c.query_row("SELECT prompt,simulation_id,status,artifact,error,model FROM generation_jobs WHERE id=?1 AND contributor_id=?2",params![id,user.id],|r|Ok(json!({"id":id,"prompt":r.get::<_,String>(0)?,"simulationId":r.get::<_,String>(1)?,"status":r.get::<_,String>(2)?,"artifact":r.get::<_,Option<String>>(3)?,"error":r.get::<_,String>(4)?,"model":r.get::<_,String>(5)?}))).optional().map_err(internal)?.ok_or_else(not_found)}).await?;
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
    s.store.run(move|c| {
        let tx=c.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate).map_err(internal)?;
        let status:String=tx.query_row("SELECT status FROM generation_jobs WHERE id=?1 AND contributor_id=?2",params![id,user.id],|r|r.get(0)).optional().map_err(internal)?.ok_or_else(not_found)?;
        if !["queued","running"].contains(&status.as_str()) {return Err(error(StatusCode::CONFLICT,"This request is already finished"));}
        tx.execute("UPDATE generation_jobs SET status='cancelled',finished_at=unixepoch(),lease_hash=NULL WHERE id=?1",[id]).map_err(internal)?;tx.commit().map_err(internal)
    }).await?;
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
    let value=s.store.run(move|c| {
        let tx=c.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate).map_err(internal)?;
        let id:i64=tx.query_row("SELECT id FROM contributors WHERE username=?1",[&username],|r|r.get(0)).optional().map_err(internal)?.ok_or_else(||error(StatusCode::NOT_FOUND,"Contributor not found"))?;
        tx.execute("UPDATE contributors SET generation_allowed=?1 WHERE id=?2",params![input.allowed,id]).map_err(internal)?;
        tx.execute("INSERT INTO generation_access_events(contributor_id,allowed) VALUES (?1,?2)",params![id,input.allowed]).map_err(internal)?;
        if !input.allowed {tx.execute("UPDATE generation_jobs SET status='cancelled',finished_at=unixepoch(),lease_hash=NULL WHERE contributor_id=?1 AND status IN ('queued','running')",[id]).map_err(internal)?;}
        tx.commit().map_err(internal)?;Ok(json!({"username":username,"allowed":input.allowed}))
    }).await?;
    Ok(Json(value))
}
async fn claim(
    State(s): State<SubmissionState>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    worker(&s, &headers)?;
    let raw = random()?;
    let hash = digest(&raw);
    let result=s.store.run(move|c| {
        let tx=c.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate).map_err(internal)?;expire(&tx)?;
        let running:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM generation_jobs WHERE status='running')",[],|r|r.get(0)).map_err(internal)?;
        if running {tx.commit().map_err(internal)?;return Ok(Value::Null);}
        let next:Option<(i64,String,String)>=tx.query_row("SELECT j.id,j.prompt,j.simulation_id FROM generation_jobs j JOIN contributors c ON c.id=j.contributor_id WHERE j.status='queued' AND c.generation_allowed=1 ORDER BY j.id LIMIT 1",[],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional().map_err(internal)?;
        let Some((id,prompt,slug))=next else{tx.commit().map_err(internal)?;return Ok(Value::Null)};
        tx.execute("UPDATE generation_jobs SET status='running',started_at=unixepoch(),lease_hash=?1,lease_expires=unixepoch()+360 WHERE id=?2",params![hash,id]).map_err(internal)?;
        tx.commit().map_err(internal)?;Ok(json!({"protocolVersion":1,"id":id,"prompt":prompt,"simulationId":slug,"lease":raw}))
    }).await?;
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
    let active=s.store.run(move|c|{expire(c)?;c.query_row("SELECT EXISTS(SELECT 1 FROM generation_jobs j JOIN contributors c ON c.id=j.contributor_id WHERE j.id=?1 AND j.status='running' AND j.lease_hash=?2 AND c.generation_allowed=1)",params![id,hash],|r|r.get::<_,bool>(0)).map_err(internal)}).await?;
    Ok(Json(json!({"active":active})))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Complete {
    lease: String,
    artifact: Option<Artifact>,
    model: String,
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
    s.store.run(move|c| {
        let tx=c.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate).map_err(internal)?;expire(&tx)?;
        let slug:String=tx.query_row("SELECT j.simulation_id FROM generation_jobs j JOIN contributors c ON c.id=j.contributor_id WHERE j.id=?1 AND j.status='running' AND j.lease_hash=?2 AND c.generation_allowed=1",params![id,hash],|r|r.get(0)).optional().map_err(internal)?.ok_or_else(||error(StatusCode::CONFLICT,"Worker lease is expired, cancelled or no longer current"))?;
        let (status,artifact,message)=if let Some(a)=input.artifact {
            if a.definition["id"]!=slug || a.definition["assessment"]["id"].as_str().is_some_and(|id|id!=slug) {return Err(error(StatusCode::UNPROCESSABLE_ENTITY,"Generated simulation and bank must use the assigned ID"));}
            ("succeeded",Some(json!({"bundleVersion":1,"definition":a.definition,"submittedBy":"","source":{"kind":"javascript","moduleCode":a.module_code}}).to_string()),"")
        } else {("failed",None,"Generation failed or hit a worker limit; start a new request to retry.")};
        tx.execute("UPDATE generation_jobs SET status=?1,artifact=?2,error=?3,model=?4,finished_at=unixepoch(),lease_hash=NULL WHERE id=?5",params![status,artifact,message,input.model,id]).map_err(internal)?;
        tx.commit().map_err(internal)
    }).await?;
    Ok(Json(json!({"id":id,"recorded":true})))
}
