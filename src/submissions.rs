//! Public drafts, private review, and publication. Uploaded JavaScript is never evaluated here.
use axum::{
    Json, Router,
    extract::{DefaultBodyLimit, Path as RoutePath, Query, State},
    http::{HeaderMap, StatusCode, header},
    response::{Html, IntoResponse, Response},
    routing::{get, post},
};
use rusqlite::{Connection, OptionalExtension, Transaction, TransactionBehavior, params};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    collections::HashSet,
    path::Path,
    sync::{Arc, Mutex, MutexGuard, PoisonError},
    time::Duration,
};
use subtle::ConstantTimeEq;

pub const MAX_DEFINITION: usize = 64 * 1024;
pub const MAX_MODULE: usize = 128 * 1024;
const MAX_NOTE: usize = 1000;
const PAGE: usize = 20;

#[derive(Clone)]
pub struct Store(Arc<Mutex<Connection>>);
impl Store {
    pub fn open(path: impl AsRef<Path>) -> std::io::Result<Self> {
        let mut options = std::fs::OpenOptions::new();
        options.read(true).write(true).create(true).truncate(false);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        options.open(path.as_ref())?;
        Self::init(Connection::open(path).map_err(std::io::Error::other)?)
    }
    pub fn memory() -> std::io::Result<Self> {
        Self::init(Connection::open_in_memory().map_err(std::io::Error::other)?)
    }
    fn init(mut connection: Connection) -> std::io::Result<Self> {
        connection
            .busy_timeout(Duration::from_secs(5))
            .map_err(std::io::Error::other)?;
        crate::migrations::migrate(&mut connection)?;
        Ok(Self(Arc::new(Mutex::new(connection))))
    }
    /// A panic in one request must not take the database offline for every later request.
    /// Any open transaction rolls back while unwinding, so the connection is safe to reuse.
    fn lock(&self) -> MutexGuard<'_, Connection> {
        self.0.lock().unwrap_or_else(PoisonError::into_inner)
    }
    pub(crate) async fn run<T: Send + 'static>(
        &self,
        work: impl FnOnce(&mut Connection) -> Result<T, ApiError> + Send + 'static,
    ) -> Result<T, ApiError> {
        let store = self.clone();
        tokio::task::spawn_blocking(move || work(&mut store.lock()))
            .await
            .map_err(internal)?
    }
    /// Operator recovery for a published entry that blocks startup, e.g. after an installed
    /// engine changed. Mirrors a maintainer's withdraw decision without a running server.
    pub fn withdraw(&self, id: i64, note: &str) -> std::io::Result<String> {
        let io = |error: ApiError| std::io::Error::other(error.1);
        let note = review_note("withdraw", note).map_err(io)?;
        let mut connection = self.lock();
        let tx = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(std::io::Error::other)?;
        let (current, revision, live): (String, i64, bool) = tx
            .query_row(
                "SELECT status, revision, published_definition IS NOT NULL \
                 FROM submissions WHERE id = ?1",
                [id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()
            .map_err(std::io::Error::other)?
            .ok_or_else(|| std::io::Error::other(format!("Submission #{id} not found")))?;
        if !live {
            return Err(std::io::Error::other(format!(
                "Submission #{id} has no published revision"
            )));
        }
        let status = withdraw_publication(&tx, id, &current).map_err(io)?;
        record_decision(&tx, id, revision, "withdraw", &status, "operator", note).map_err(io)?;
        tx.commit().map_err(std::io::Error::other)?;
        Ok(status)
    }
}

#[derive(Clone)]
pub struct SubmissionState {
    pub(crate) store: Store,
    pub(crate) catalog: Arc<Value>,
    pub(crate) builtin_ids: Arc<HashSet<String>>,
    pub(crate) builtin_banks: Arc<HashSet<String>>,
    shell: Arc<String>,
    admin_token: Option<Arc<str>>,
    pub(crate) secure_cookies: bool,
    pub(crate) generation: Option<Arc<crate::generation::GenerationConfig>>,
}
impl SubmissionState {
    pub fn new(
        store: Store,
        catalog: Value,
        shell: String,
        admin_token: Option<String>,
        secure_cookies: bool,
    ) -> std::io::Result<Self> {
        if admin_token.as_ref().is_some_and(|token| {
            token.len() < 32
                || token.len() > 256
                || !token
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || b"-_.".contains(&byte))
        }) {
            return Err(std::io::Error::other(
                "ADMIN_TOKEN must be 32–256 ASCII letters, digits, hyphens, underscores or dots",
            ));
        }
        let definitions = catalog["simulations"].as_array().unwrap();
        check_published_against_catalog(&store.lock(), definitions)?;
        let builtin_ids = definitions
            .iter()
            .filter_map(|def| def["id"].as_str().map(str::to_owned))
            .collect();
        let builtin_banks = definitions
            .iter()
            .filter_map(|def| def["assessment"]["id"].as_str().map(str::to_owned))
            .collect();
        Ok(Self {
            store,
            catalog: Arc::new(catalog),
            builtin_ids: Arc::new(builtin_ids),
            builtin_banks: Arc::new(builtin_banks),
            shell: Arc::new(shell),
            admin_token: admin_token.map(Arc::from),
            secure_cookies,
            generation: None,
        })
    }
    pub(crate) fn authorize(&self, headers: &HeaderMap) -> Result<(), ApiError> {
        let expected = self
            .admin_token
            .as_ref()
            .ok_or_else(|| error(StatusCode::SERVICE_UNAVAILABLE, "Review is not configured"))?;
        let supplied = headers
            .get(header::AUTHORIZATION)
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.strip_prefix("Bearer "))
            .unwrap_or("");
        if !bool::from(expected.as_bytes().ct_eq(supplied.as_bytes())) {
            return Err(error(
                StatusCode::UNAUTHORIZED,
                "A valid administrator token is required",
            ));
        }
        Ok(())
    }
}

/// Refuse to start when deployed built-ins break live submissions; name the record to fix.
fn check_published_against_catalog(
    connection: &Connection,
    definitions: &[Value],
) -> std::io::Result<()> {
    let mut statement = connection
        .prepare(
            "SELECT id, simulation_id, published_engine_id, published_definition FROM submissions \
             WHERE published_definition IS NOT NULL AND published_engine_id IS NOT NULL",
        )
        .map_err(std::io::Error::other)?;
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
            ))
        })
        .map_err(std::io::Error::other)?;
    for row in rows {
        let (id, simulation, engine, definition) = row.map_err(std::io::Error::other)?;
        let result = match definitions.iter().find(|def| def["id"] == engine) {
            None => Err("the installed engine was removed".to_owned()),
            Some(builtin) => serde_json::from_str::<Value>(&definition)
                .map_err(|error| error.to_string())
                .and_then(|definition| crate::validation::engine_contract(&definition, builtin)),
        };
        if let Err(reason) = result {
            return Err(std::io::Error::other(format!(
                "Published submission #{id} ({simulation}) no longer fits installed engine \
                 {engine}: {reason}. Restore the engine or run `commonlab withdraw {id} \"<note>\"`."
            )));
        }
    }
    for def in definitions {
        let conflict: Option<i64> = connection
            .query_row(
                "SELECT id FROM submissions WHERE simulation_id = ?1 \
                 AND (status IN ('pending','published') OR published_definition IS NOT NULL) \
                 UNION ALL SELECT submission_id FROM submission_banks WHERE bank_id = ?2 LIMIT 1",
                params![def["id"].as_str(), def["assessment"]["id"].as_str()],
                |row| row.get(0),
            )
            .optional()
            .map_err(std::io::Error::other)?;
        if let Some(id) = conflict {
            return Err(std::io::Error::other(format!(
                "Built-in simulation {} conflicts with submission #{id}; rename the built-in \
                 simulation or its assessment bank before deployment",
                def["id"]
            )));
        }
    }
    Ok(())
}

pub fn router(state: SubmissionState) -> Router {
    let accounts = crate::auth::router(state.store.clone(), state.secure_cookies);
    let contributions = crate::contributions::router(state.clone());
    let generation = crate::generation::router(state.clone());
    Router::new()
        .route("/api/submissions/config", get(config))
        .route("/api/submissions/engines", get(engines))
        .route("/api/submissions", post(submit))
        .route("/api/admin/submissions", get(list))
        .route("/api/admin/limits", get(limits_get).put(limits_put))
        .route("/api/admin/submissions/{id}", get(detail))
        .route("/api/admin/submissions/{id}/review", post(review))
        .route("/simulations/catalog.json", get(catalog))
        .route("/simulations/{*file}", get(published))
        .layer(DefaultBodyLimit::max(256 * 1024))
        .layer(axum::middleware::map_response(no_cache))
        .with_state(state)
        .merge(accounts)
        .merge(contributions)
        .merge(generation)
}
pub(crate) async fn no_cache(mut response: Response) -> Response {
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, "no-store".parse().unwrap());
    response
        .headers_mut()
        .insert(header::X_CONTENT_TYPE_OPTIONS, "nosniff".parse().unwrap());
    response
}
/// One page of a newest-first listing queried with `LIMIT PAGE + 1`.
pub(crate) fn page(mut items: Vec<Value>) -> Json<Value> {
    let has_more = items.len() > PAGE;
    items.truncate(PAGE);
    Json(json!({"items": items, "hasMore": has_more}))
}
async fn limits_get(
    State(state): State<SubmissionState>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    state.authorize(&headers)?;
    let limits = state
        .store
        .run(|connection| crate::limits::Limits::load(connection).map_err(internal))
        .await?;
    Ok(Json(
        json!({"limits": limits.json(), "defaults": crate::limits::Limits::defaults_json()}),
    ))
}
async fn limits_put(
    State(state): State<SubmissionState>,
    headers: HeaderMap,
    Json(input): Json<crate::limits::Change>,
) -> Result<Json<Value>, ApiError> {
    state.authorize(&headers)?;
    let limits = state
        .store
        .run(move |connection| {
            let tx = connection
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(internal)?;
            crate::limits::Limits::default()
                .save(&tx, &input.limits)
                .map_err(|message| error(StatusCode::UNPROCESSABLE_ENTITY, message))?;
            let limits = crate::limits::Limits::load(&tx).map_err(internal)?;
            tx.commit().map_err(internal)?;
            Ok(limits)
        })
        .await?;
    Ok(Json(
        json!({"limits": limits.json(), "defaults": crate::limits::Limits::defaults_json()}),
    ))
}
async fn config(State(state): State<SubmissionState>) -> Json<Value> {
    Json(
        json!({"enabled": state.admin_token.is_some(), "maxDefinitionBytes": MAX_DEFINITION, "maxModuleBytes": MAX_MODULE}),
    )
}

async fn engines(State(state): State<SubmissionState>) -> Json<Value> {
    Json(json!({"ids": state.builtin_ids.iter().collect::<Vec<_>>()}))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Submission {
    pub(crate) definition: Value,
    #[serde(default)]
    pub(crate) engine_id: Option<String>,
    #[serde(default)]
    pub(crate) module_code: Option<String>,
    #[serde(default)]
    pub(crate) submitted_by: String,
}
async fn submit(
    State(state): State<SubmissionState>,
    headers: HeaderMap,
    Json(input): Json<Submission>,
) -> Result<impl IntoResponse, ApiError> {
    if state.admin_token.is_none() {
        return Err(error(
            StatusCode::SERVICE_UNAVAILABLE,
            "Submissions are disabled until a reviewer is configured",
        ));
    }
    crate::auth::csrf(&headers)?;
    let contributor = crate::auth::account(&state.store, &headers, state.secure_cookies).await?;
    crate::contributions::validate_input(&state, &input)?;
    let definition = input.definition.to_string();
    let id = input.definition["id"].as_str().unwrap().to_owned();
    let receipt = state
        .store
        .run(move |connection| {
            // IMMEDIATE serializes quotas + insertion across multiple server processes too.
            let tx = connection
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(internal)?;
            crate::contributions::check_capacity(&tx, true, true)?;
            tx.execute(
                "INSERT INTO submissions (simulation_id, definition, engine_id, module_code, \
                 submitted_by, contributor_id, updated_at) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, strftime('%Y-%m-%dT%H:%M:%fZ','now'))",
                params![
                    id,
                    definition,
                    input.engine_id,
                    input.module_code,
                    input.submitted_by.trim(),
                    contributor.id
                ],
            )
            .map_err(|err| {
                conflict_or_internal(
                    err,
                    "Simulation ID has already been submitted; choose a new ID",
                )
            })?;
            let receipt = tx.last_insert_rowid();
            crate::contributions::reserve_bank(&tx, receipt, &input.definition)?;
            crate::contributions::event(
                &tx,
                receipt,
                1,
                "submitted",
                "pending",
                "contributor",
                "",
            )?;
            tx.commit().map_err(internal)?;
            Ok(receipt)
        })
        .await?;
    Ok((
        StatusCode::CREATED,
        Json(json!({"id":receipt,"revision":1,"status":"pending"})),
    ))
}

#[derive(Deserialize)]
struct ListQuery {
    status: Option<String>,
    before: Option<i64>,
}
async fn list(
    State(state): State<SubmissionState>,
    headers: HeaderMap,
    Query(query): Query<ListQuery>,
) -> Result<Json<Value>, ApiError> {
    state.authorize(&headers)?;
    let status = query.status.unwrap_or_else(|| "pending".into());
    // `live` finds every public entry, whatever the status of its newest revision.
    if !["pending", "published", "rejected", "withdrawn", "live"].contains(&status.as_str())
        || query.before.is_some_and(|id| id <= 0)
    {
        return Err(error(StatusCode::BAD_REQUEST, "Invalid queue filter"));
    }
    let items = state
        .store
        .run(move |connection| {
            let mut statement = connection
                .prepare(
                    "SELECT id, simulation_id, json_extract(definition,'$.title'), submitted_by, \
                     status, created_at, reviewed_at, review_note, module_code IS NOT NULL, \
                     published_revision FROM submissions \
                     WHERE (status = ?1 OR (?1 = 'live' AND published_definition IS NOT NULL)) \
                     AND (?2 IS NULL OR id < ?2) ORDER BY id DESC LIMIT 21",
                )
                .map_err(internal)?;
            let rows = statement
                .query_map(params![status, query.before], |row| {
                    let published = row.get::<_, Option<i64>>(9)?;
                    Ok(json!({
                        "id": row.get::<_, i64>(0)?,
                        "simulationId": row.get::<_, String>(1)?,
                        "title": row.get::<_, String>(2)?,
                        "submittedBy": row.get::<_, String>(3)?,
                        "status": row.get::<_, String>(4)?,
                        "createdAt": row.get::<_, String>(5)?,
                        "reviewedAt": row.get::<_, Option<String>>(6)?,
                        "reviewNote": row.get::<_, String>(7)?,
                        "hasCode": row.get::<_, bool>(8)?,
                        "publishedRevision": published,
                        "live": published.is_some(),
                    }))
                })
                .map_err(internal)?;
            rows.collect::<rusqlite::Result<Vec<_>>>().map_err(internal)
        })
        .await?;
    Ok(page(items))
}
async fn detail(
    State(state): State<SubmissionState>,
    headers: HeaderMap,
    RoutePath(id): RoutePath<i64>,
) -> Result<Json<Value>, ApiError> {
    state.authorize(&headers)?;
    let (definition, mut item) = state
        .store
        .run(move |connection| {
            connection
                .query_row(
                    "SELECT definition, engine_id, module_code, submitted_by, status, review_note, \
                     revision, published_revision, \
                     (SELECT username FROM contributors WHERE contributors.id = submissions.contributor_id) \
                     FROM submissions WHERE id = ?1",
                    [id],
                    |row| {
                        let published = row.get::<_, Option<i64>>(7)?;
                        Ok((
                            row.get::<_, String>(0)?,
                            json!({
                                "id": id,
                                "engineId": row.get::<_, Option<String>>(1)?,
                                "moduleCode": row.get::<_, Option<String>>(2)?,
                                "submittedBy": row.get::<_, String>(3)?,
                                "status": row.get::<_, String>(4)?,
                                "reviewNote": row.get::<_, String>(5)?,
                                "revision": row.get::<_, i64>(6)?,
                                "publishedRevision": published,
                                "hasPublication": published.is_some(),
                                "contributorUsername": row.get::<_, Option<String>>(8)?,
                            }),
                        ))
                    },
                )
                .optional()
                .map_err(internal)?
                .ok_or_else(not_found)
        })
        .await?;
    item["definition"] = serde_json::from_str(&definition).map_err(internal)?;
    Ok(Json(item))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Review {
    decision: String,
    #[serde(default)]
    revision: Option<i64>,
    #[serde(default)]
    code_reviewed: bool,
    #[serde(default)]
    note: String,
}
struct UnderReview {
    status: String,
    definition: String,
    has_code: bool,
    engine: Option<String>,
    revision: i64,
    live: bool,
}
/// Validate a decision's note; only publication may omit an explanation.
fn review_note<'a>(decision: &str, note: &'a str) -> Result<&'a str, ApiError> {
    if !["publish", "reject", "withdraw"].contains(&decision) || note.chars().count() > MAX_NOTE {
        return Err(error(
            StatusCode::UNPROCESSABLE_ENTITY,
            "Invalid review decision or note (maximum 1000 characters)",
        ));
    }
    if decision != "publish" && note.trim().is_empty() {
        return Err(error(
            StatusCode::UNPROCESSABLE_ENTITY,
            "Explain why the submission was rejected or withdrawn",
        ));
    }
    Ok(note.trim())
}
/// Remove the live snapshot. A newer pending/rejected revision keeps its own status.
fn withdraw_publication(tx: &Transaction<'_>, id: i64, current: &str) -> Result<String, ApiError> {
    tx.execute(
        "UPDATE submissions SET published_definition = NULL, published_engine_id = NULL, \
         published_module_code = NULL, published_revision = NULL WHERE id = ?1",
        [id],
    )
    .map_err(internal)?;
    Ok(if current == "published" {
        "withdrawn"
    } else {
        current
    }
    .to_owned())
}
fn record_decision(
    tx: &Transaction<'_>,
    id: i64,
    revision: i64,
    decision: &str,
    status: &str,
    actor: &str,
    note: &str,
) -> Result<(), ApiError> {
    tx.execute(
        "UPDATE submissions SET status = ?1, review_note = ?2, \
         reviewed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), \
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?3",
        params![status, note, id],
    )
    .map_err(internal)?;
    crate::contributions::event(tx, id, revision, decision, status, actor, note)
}
async fn review(
    State(state): State<SubmissionState>,
    headers: HeaderMap,
    RoutePath(id): RoutePath<i64>,
    Json(input): Json<Review>,
) -> Result<Json<Value>, ApiError> {
    state.authorize(&headers)?;
    let expected_revision = input
        .revision
        .filter(|revision| *revision > 0)
        .ok_or_else(|| {
            error(
                StatusCode::UNPROCESSABLE_ENTITY,
                "Refresh the submission and provide its current revision",
            )
        })?;
    let note = review_note(&input.decision, &input.note)?.to_owned();
    let catalog = state.catalog.clone();
    let (status, live) = state
        .store
        .run(move |connection| {
            let decision = input.decision.as_str();
            let tx = connection
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(internal)?;
            let current = tx
                .query_row(
                    "SELECT status, definition, module_code IS NOT NULL, engine_id, revision, \
                     published_definition IS NOT NULL FROM submissions WHERE id = ?1",
                    [id],
                    |row| {
                        Ok(UnderReview {
                            status: row.get(0)?,
                            definition: row.get(1)?,
                            has_code: row.get(2)?,
                            engine: row.get(3)?,
                            revision: row.get(4)?,
                            live: row.get(5)?,
                        })
                    },
                )
                .optional()
                .map_err(internal)?
                .ok_or_else(not_found)?;
            if current.revision != expected_revision {
                return Err(error(
                    StatusCode::CONFLICT,
                    "Submission changed since inspection; reload and review the new source",
                ));
            }
            if (decision == "withdraw" && !current.live)
                || (decision != "withdraw" && current.status != "pending")
            {
                return Err(error(
                    StatusCode::CONFLICT,
                    "Submission is no longer in the required review state; refresh the queue",
                ));
            }
            let status = match decision {
                "publish" => {
                    if current.has_code && !input.code_reviewed {
                        return Err(error(
                            StatusCode::UNPROCESSABLE_ENTITY,
                            "Publishing new engine code requires explicit confirmation of a trusted code review",
                        ));
                    }
                    let unprocessable = |message| error(StatusCode::UNPROCESSABLE_ENTITY, message);
                    let definition =
                        serde_json::from_str::<Value>(&current.definition).map_err(internal)?;
                    crate::validation::validate(&definition).map_err(unprocessable)?;
                    if let Some(engine) = &current.engine {
                        let builtin = catalog["simulations"]
                            .as_array()
                            .unwrap()
                            .iter()
                            .find(|def| def["id"] == *engine)
                            .ok_or_else(|| unprocessable("Installed engine is no longer available".into()))?;
                        crate::validation::engine_contract(&definition, builtin)
                            .map_err(unprocessable)?;
                    }
                    tx.execute(
                        "UPDATE submissions SET published_definition = definition, \
                         published_engine_id = engine_id, published_module_code = module_code, \
                         published_revision = revision WHERE id = ?1",
                        [id],
                    )
                    .map_err(internal)?;
                    "published".to_owned()
                }
                "reject" => "rejected".to_owned(),
                _ => withdraw_publication(&tx, id, &current.status)?,
            };
            record_decision(&tx, id, current.revision, decision, &status, "maintainer", &note)?;
            tx.commit().map_err(internal)?;
            Ok((status, decision == "publish" || (decision != "withdraw" && current.live)))
        })
        .await?;
    Ok(Json(json!({"id":id,"status":status,"hasPublication":live})))
}

async fn catalog(State(state): State<SubmissionState>) -> Result<Json<Value>, ApiError> {
    let definitions = state
        .store
        .run(|connection| {
            let mut statement = connection
                .prepare("SELECT published_definition FROM submissions WHERE published_definition IS NOT NULL ORDER BY id")
                .map_err(internal)?;
            let rows = statement
                .query_map([], |row| row.get::<_, String>(0))
                .map_err(internal)?;
            rows.map(|row| serde_json::from_str::<Value>(&row.map_err(internal)?).map_err(internal))
                .collect::<Result<Vec<_>, _>>()
        })
        .await?;
    let mut catalog = (*state.catalog).clone();
    // Provenance belongs to the public catalog, not contributor-controlled definitions.
    catalog["communitySimulationIds"] = json!(
        definitions
            .iter()
            .map(|definition| &definition["id"])
            .collect::<Vec<_>>()
    );
    catalog["simulations"]
        .as_array_mut()
        .unwrap()
        .extend(definitions);
    Ok(Json(catalog))
}
async fn published(
    State(state): State<SubmissionState>,
    RoutePath(file): RoutePath<String>,
) -> Result<Response, ApiError> {
    let (id, module) = if let Some(id) = file.strip_suffix(".js") {
        (id.to_owned(), true)
    } else {
        (
            file.strip_suffix(".html").unwrap_or(&file).to_owned(),
            false,
        )
    };
    let item = state
        .store
        .run(move |connection| {
            connection
                .query_row(
                    "SELECT published_engine_id, published_module_code FROM submissions \
                     WHERE simulation_id = ?1 AND published_definition IS NOT NULL",
                    [id],
                    |row| {
                        Ok((
                            row.get::<_, Option<String>>(0)?,
                            row.get::<_, Option<String>>(1)?,
                        ))
                    },
                )
                .optional()
                .map_err(internal)?
                .ok_or_else(not_found)
        })
        .await?;
    if module {
        let code = match item {
            (Some(engine), None) => {
                format!("export {{ mount }} from '/simulations/{engine}.js';\n")
            }
            (_, Some(code)) => code,
            _ => return Err(internal("Invalid stored engine")),
        };
        Ok((
            [(header::CONTENT_TYPE, "text/javascript; charset=utf-8")],
            code,
        )
            .into_response())
    } else {
        Ok(Html((*state.shell).clone()).into_response())
    }
}

#[derive(Debug)]
pub(crate) struct ApiError(StatusCode, String);
pub(crate) fn error(status: StatusCode, message: impl Into<String>) -> ApiError {
    ApiError(status, message.into())
}
fn not_found() -> ApiError {
    error(StatusCode::NOT_FOUND, "Not found")
}
pub(crate) fn internal(error: impl std::fmt::Display) -> ApiError {
    tracing::error!(%error, "Storage operation failed");
    error_response()
}
/// Map a uniqueness violation to a client-facing conflict; anything else is internal.
pub(crate) fn conflict_or_internal(err: rusqlite::Error, message: &str) -> ApiError {
    match err {
        rusqlite::Error::SqliteFailure(ref code, _)
            if code.code == rusqlite::ErrorCode::ConstraintViolation =>
        {
            error(StatusCode::CONFLICT, message)
        }
        err => internal(err),
    }
}
fn error_response() -> ApiError {
    error(
        StatusCode::INTERNAL_SERVER_ERROR,
        "Submission service is temporarily unavailable",
    )
}
impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.0, Json(json!({"error": self.1}))).into_response()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn a_panicking_request_does_not_take_the_database_offline() {
        let store = Store::memory().unwrap();
        let panicked = store
            .run(|connection| -> Result<(), ApiError> {
                let tx = connection.transaction().unwrap();
                tx.execute(
                    "INSERT INTO contributors(username,password_hash) VALUES ('ghost','x')",
                    [],
                )
                .unwrap();
                panic!("simulated handler bug")
            })
            .await;
        assert_eq!(panicked.unwrap_err().0, StatusCode::INTERNAL_SERVER_ERROR);
        // The lock recovers and the half-finished transaction was rolled back.
        let count = store
            .run(|connection| {
                connection
                    .query_row("SELECT COUNT(*) FROM contributors", [], |row| {
                        row.get::<_, i64>(0)
                    })
                    .map_err(internal)
            })
            .await
            .unwrap();
        assert_eq!(count, 0);
    }

    #[test]
    fn startup_errors_name_the_blocking_submission_and_its_recovery() {
        let store = Store::memory().unwrap();
        store
            .lock()
            .execute_batch(
                "INSERT INTO submissions(simulation_id, definition, engine_id, submitted_by, \
                 status, published_definition, published_engine_id) \
                 VALUES ('stale-lab', '{}', 'pendulum', '', 'published', '{}', 'pendulum')",
            )
            .unwrap();
        let catalog: Value =
            serde_json::from_str(include_str!("../public/simulations/catalog.json")).unwrap();
        let builtins = catalog["simulations"].as_array().unwrap();
        for definitions in [&builtins[..], &[]] {
            let message = check_published_against_catalog(&store.lock(), definitions)
                .unwrap_err()
                .to_string();
            assert!(message.contains("#1 (stale-lab)"), "{message}");
            assert!(message.contains("commonlab withdraw 1"), "{message}");
        }
        store.withdraw(1, "Engine changed").unwrap();
        check_published_against_catalog(&store.lock(), builtins).unwrap();
    }
}
