//! Owner-only draft revisions. A separate approved snapshot prevents edits bypassing review.
use crate::submissions::{ApiError, Submission, SubmissionState, error, internal, no_cache};
use axum::{
    Json, Router,
    extract::{DefaultBodyLimit, Path, Query, State},
    http::{HeaderMap, StatusCode},
    routing::get,
};
use rusqlite::{OptionalExtension, Transaction, params};
use serde_json::{Value, json};

pub fn router(state: SubmissionState) -> Router {
    Router::new()
        .route("/api/contributor/submissions", get(list))
        .route("/api/contributor/submissions/{id}", get(detail).put(edit))
        .route("/api/contributor/submissions/{id}/history", get(history))
        .layer(DefaultBodyLimit::max(256 * 1024))
        .layer(axum::middleware::map_response(no_cache))
        .with_state(state)
}
#[derive(serde::Deserialize, Default)]
#[serde(deny_unknown_fields)]
struct ListQuery {
    status: Option<String>,
    before: Option<i64>,
}
async fn list(
    State(state): State<SubmissionState>,
    headers: HeaderMap,
    Query(query): Query<ListQuery>,
) -> Result<Json<Value>, ApiError> {
    let user = crate::auth::account(&state.store, &headers, state.secure_cookies).await?;
    let status = query.status.unwrap_or_else(|| "all".into());
    if !["all", "pending", "published", "rejected", "withdrawn"].contains(&status.as_str())
        || query.before.is_some_and(|id| id <= 0)
    {
        return Err(error(
            StatusCode::UNPROCESSABLE_ENTITY,
            "Invalid status filter or pagination cursor",
        ));
    }
    let items=state.store.run(move|connection| {
        let mut statement=connection.prepare("SELECT id,simulation_id,json_extract(definition,'$.title'),status,revision,published_revision,review_note,created_at,updated_at,reviewed_at FROM submissions WHERE contributor_id=?1 AND (?2='all' OR status=?2) AND (?3 IS NULL OR id<?3) ORDER BY id DESC LIMIT 21").map_err(internal)?;
        statement.query_map(params![user.id,status,query.before],|row|Ok(json!({"id":row.get::<_,i64>(0)?,"simulationId":row.get::<_,String>(1)?,"title":row.get::<_,String>(2)?,"status":row.get::<_,String>(3)?,"revision":row.get::<_,i64>(4)?,"publishedRevision":row.get::<_,Option<i64>>(5)?,"reviewNote":row.get::<_,String>(6)?,"createdAt":row.get::<_,String>(7)?,"updatedAt":row.get::<_,Option<String>>(8)?,"reviewedAt":row.get::<_,Option<String>>(9)?}))).map_err(internal)?.collect::<Result<Vec<_>,_>>().map_err(internal)
    }).await?;
    let has_more = items.len() > 20;
    Ok(Json(
        json!({"items":items.into_iter().take(20).collect::<Vec<_>>(),"hasMore":has_more}),
    ))
}
async fn history(
    State(state): State<SubmissionState>,
    headers: HeaderMap,
    Path(id): Path<i64>,
) -> Result<Json<Value>, ApiError> {
    let user = crate::auth::account(&state.store, &headers, state.secure_cookies).await?;
    let items=state.store.run(move|connection| {
        let owned:bool=connection.query_row("SELECT EXISTS(SELECT 1 FROM submissions WHERE id=?1 AND contributor_id=?2)",params![id,user.id],|row|row.get(0)).map_err(internal)?;
        if !owned {return Err(error(StatusCode::NOT_FOUND,"Submission not found"));}
        let mut statement=connection.prepare("SELECT revision,action,status,actor,note,created_at FROM submission_events WHERE submission_id=?1 ORDER BY id LIMIT 200").map_err(internal)?;
        statement.query_map([id],|row|Ok(json!({"revision":row.get::<_,i64>(0)?,"action":row.get::<_,String>(1)?,"status":row.get::<_,String>(2)?,"actor":row.get::<_,String>(3)?,"note":row.get::<_,String>(4)?,"createdAt":row.get::<_,String>(5)?}))).map_err(internal)?.collect::<Result<Vec<_>,_>>().map_err(internal)
    }).await?;
    Ok(Json(json!({"id":id,"events":items})))
}
pub(crate) fn validate_input(state: &SubmissionState, input: &Submission) -> Result<(), ApiError> {
    if input.definition.to_string().len() > crate::submissions::MAX_DEFINITION {
        return Err(error(
            StatusCode::PAYLOAD_TOO_LARGE,
            "Definition exceeds 64 KiB",
        ));
    }
    crate::validation::validate(&input.definition)
        .map_err(|message| error(StatusCode::UNPROCESSABLE_ENTITY, message))?;
    let id = input.definition["id"].as_str().unwrap();
    if state.builtin_ids.contains(id)
        || input.definition["assessment"]["id"]
            .as_str()
            .is_some_and(|id| state.builtin_banks.contains(id))
    {
        return Err(error(
            StatusCode::CONFLICT,
            "Simulation or assessment ID belongs to a built-in simulation",
        ));
    }
    match (&input.engine_id, &input.module_code) {
        (Some(engine), None) if state.builtin_ids.contains(engine) => {
            let builtin = state.catalog["simulations"]
                .as_array()
                .unwrap()
                .iter()
                .find(|def| def["id"] == *engine)
                .unwrap();
            crate::validation::engine_contract(&input.definition, builtin)
                .map_err(|message| error(StatusCode::UNPROCESSABLE_ENTITY, message))?;
        }
        (None, Some(code))
            if !code.trim().is_empty() && code.len() <= crate::submissions::MAX_MODULE => {}
        _ => {
            return Err(error(
                StatusCode::UNPROCESSABLE_ENTITY,
                "Choose one installed engine or provide a nonempty JavaScript module of at most 128 KiB",
            ));
        }
    }
    if input.submitted_by.chars().count() > 100 {
        return Err(error(
            StatusCode::UNPROCESSABLE_ENTITY,
            "Submitter name must be at most 100 characters",
        ));
    }
    Ok(())
}
pub(crate) fn reserve_bank(tx: &Transaction<'_>, id: i64, def: &Value) -> Result<(), ApiError> {
    if let Some(bank) = def["assessment"]["id"].as_str() {
        let previous: Option<(i64, String)> = tx
            .query_row(
                "SELECT submission_id,bank_json FROM submission_banks WHERE bank_id=?1",
                [bank],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .map_err(internal)?;
        if let Some((owner, old)) = previous {
            if owner != id {
                return Err(error(
                    StatusCode::CONFLICT,
                    "Assessment ID is reserved by another submission",
                ));
            }
            let old: Value = serde_json::from_str(&old).map_err(internal)?;
            if old != def["assessment"]
                && def["assessment"]["version"].as_f64().unwrap()
                    <= old["version"].as_f64().unwrap()
            {
                return Err(error(
                    StatusCode::UNPROCESSABLE_ENTITY,
                    "Increase the assessment version when changing a previously submitted bank, including one removed in an earlier revision",
                ));
            }
        }
        tx.execute("INSERT INTO submission_banks(bank_id,submission_id,bank_json) VALUES (?1,?2,?3) ON CONFLICT(bank_id) DO UPDATE SET bank_json=excluded.bank_json",params![bank,id,def["assessment"].to_string()]).map_err(internal)?;
    }
    Ok(())
}
pub(crate) fn event(
    tx: &Transaction<'_>,
    id: i64,
    revision: i64,
    action: &str,
    status: &str,
    actor: &str,
    note: &str,
) -> Result<(), ApiError> {
    tx.execute("INSERT INTO submission_events(submission_id,revision,action,status,actor,note) VALUES (?1,?2,?3,?4,?5,?6)",params![id,revision,action,status,actor,note]).map_err(internal)?;
    Ok(())
}
async fn detail(
    State(state): State<SubmissionState>,
    headers: HeaderMap,
    Path(id): Path<i64>,
) -> Result<Json<Value>, ApiError> {
    let user = crate::auth::account(&state.store, &headers, state.secure_cookies).await?;
    let value=state.store.run(move|connection| {
        connection.query_row("SELECT definition,engine_id,module_code,submitted_by,status,review_note,revision,published_revision,created_at,updated_at,reviewed_at FROM submissions WHERE id=?1 AND contributor_id=?2",params![id,user.id],|row|Ok(json!({"id":id,"definition":row.get::<_,String>(0)?,"engineId":row.get::<_,Option<String>>(1)?,"moduleCode":row.get::<_,Option<String>>(2)?,"submittedBy":row.get::<_,String>(3)?,"status":row.get::<_,String>(4)?,"reviewNote":row.get::<_,String>(5)?,"revision":row.get::<_,i64>(6)?,"publishedRevision":row.get::<_,Option<i64>>(7)?,"createdAt":row.get::<_,String>(8)?,"updatedAt":row.get::<_,Option<String>>(9)?,"reviewedAt":row.get::<_,Option<String>>(10)?}))).optional().map_err(internal)?.ok_or_else(||error(StatusCode::NOT_FOUND,"Submission not found"))
    }).await?;
    let mut value = value;
    value["definition"] =
        serde_json::from_str(value["definition"].as_str().unwrap()).map_err(internal)?;
    value["hasPublication"] = json!(!value["publishedRevision"].is_null());
    Ok(Json(value))
}
async fn edit(
    State(state): State<SubmissionState>,
    headers: HeaderMap,
    Path(id): Path<i64>,
    Json(mut payload): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    crate::auth::csrf(&headers)?;
    let user = crate::auth::account(&state.store, &headers, state.secure_cookies).await?;
    let revision = payload
        .as_object_mut()
        .and_then(|map| map.remove("revision"))
        .and_then(|v| v.as_i64())
        .filter(|v| *v > 0)
        .ok_or_else(|| {
            error(
                StatusCode::UNPROCESSABLE_ENTITY,
                "A positive current revision is required",
            )
        })?;
    let input: Submission = serde_json::from_value(payload)
        .map_err(|err| error(StatusCode::UNPROCESSABLE_ENTITY, err.to_string()))?;
    validate_input(&state, &input)?;
    let result=state.store.run(move|connection| {
        let tx=connection.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate).map_err(internal)?;
        let (current,sim,old,status):(i64,String,String,String)=tx.query_row("SELECT revision,simulation_id,definition,status FROM submissions WHERE id=?1 AND contributor_id=?2",params![id,user.id],|row|Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?))).optional().map_err(internal)?.ok_or_else(||error(StatusCode::NOT_FOUND,"Submission not found"))?;
        if current!=revision {return Err(error(StatusCode::CONFLICT,"Submission changed; reload before saving. Your local draft has not been overwritten."));}
        if input.definition["id"]!=sim {return Err(error(StatusCode::UNPROCESSABLE_ENTITY,"Simulation ID cannot change when editing an existing submission"));}
        if current>=50 {return Err(error(StatusCode::TOO_MANY_REQUESTS,"Revision limit reached for this submission"));}
        let recent:i64=tx.query_row("SELECT (SELECT COUNT(*) FROM submissions WHERE created_at>=strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 hour'))+(SELECT COUNT(*) FROM submission_events WHERE action='edited' AND created_at>=strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 hour'))",[],|row|row.get(0)).map_err(internal)?;
        let pending:i64=tx.query_row("SELECT COUNT(*) FROM submissions WHERE status='pending'",[],|row|row.get(0)).map_err(internal)?;
        if recent>=100||(status!="pending"&&pending>=500) {return Err(error(StatusCode::TOO_MANY_REQUESTS,"Submission queue is full; please try again later"));}
        let old:Value=serde_json::from_str(&old).map_err(internal)?;
        if old["assessment"].is_object() && input.definition["assessment"].is_object() && old["assessment"]["id"]==input.definition["assessment"]["id"] && old["assessment"]!=input.definition["assessment"] {
            let old_version=old["assessment"]["version"].as_f64().unwrap();
            if input.definition["assessment"]["version"].as_f64().unwrap()<=old_version {return Err(error(StatusCode::UNPROCESSABLE_ENTITY,"Increase the assessment version when changing an existing question bank"));}
        }
        reserve_bank(&tx,id,&input.definition)?;
        tx.execute("UPDATE submissions SET definition=?1,engine_id=?2,module_code=?3,submitted_by=?4,status='pending',review_note='',reviewed_at=NULL,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),revision=revision+1 WHERE id=?5",params![input.definition.to_string(),input.engine_id,input.module_code,input.submitted_by.trim(),id]).map_err(|err| if matches!(err,rusqlite::Error::SqliteFailure(ref code,_) if code.code==rusqlite::ErrorCode::ConstraintViolation) {error(StatusCode::CONFLICT,"Assessment ID is already submitted")}else{internal(err)})?;
        event(&tx,id,current+1,"edited","pending","contributor","")?;
        tx.commit().map_err(internal)?;Ok(current+1)
    }).await?;
    Ok(Json(json!({"id":id,"revision":result,"status":"pending"})))
}
