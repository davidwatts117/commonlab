//! Public drafts, private review, and publication. Uploaded JavaScript is never evaluated here.
use axum::{
    Json, Router,
    extract::{DefaultBodyLimit, Path as RoutePath, Query, State},
    http::{HeaderMap, StatusCode, header},
    response::{Html, IntoResponse, Response},
    routing::{get, post},
};
use rusqlite::{Connection, OptionalExtension, params};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    collections::HashSet,
    path::Path,
    sync::{Arc, Mutex},
    time::Duration,
};
use subtle::ConstantTimeEq;

pub const MAX_DEFINITION: usize = 64 * 1024;
pub const MAX_MODULE: usize = 128 * 1024;

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
    fn init(connection: Connection) -> std::io::Result<Self> {
        connection
            .busy_timeout(Duration::from_secs(5))
            .map_err(std::io::Error::other)?;
        let version: u32 = connection
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .map_err(std::io::Error::other)?;
        if version > 1 {
            return Err(std::io::Error::other(
                "Unsupported submission database version",
            ));
        }
        connection.execute_batch("PRAGMA journal_mode=WAL;
            CREATE TABLE IF NOT EXISTS submissions (
                id INTEGER PRIMARY KEY,
                simulation_id TEXT NOT NULL UNIQUE,
                definition TEXT NOT NULL,
                engine_id TEXT,
                module_code TEXT,
                submitted_by TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','published','rejected','withdrawn')),
                created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
                reviewed_at TEXT,
                review_note TEXT NOT NULL DEFAULT '',
                CHECK ((engine_id IS NULL) != (module_code IS NULL))
            );
            CREATE UNIQUE INDEX IF NOT EXISTS submission_bank ON submissions(json_extract(definition, '$.assessment.id'));
            CREATE INDEX IF NOT EXISTS submission_status ON submissions(status, id);
            CREATE INDEX IF NOT EXISTS submission_created ON submissions(created_at);
            PRAGMA user_version=1;").map_err(std::io::Error::other)?;
        Ok(Self(Arc::new(Mutex::new(connection))))
    }
    async fn run<T: Send + 'static>(
        &self,
        work: impl FnOnce(&mut Connection) -> Result<T, ApiError> + Send + 'static,
    ) -> Result<T, ApiError> {
        let store = self.clone();
        tokio::task::spawn_blocking(move || {
            let mut connection = store
                .0
                .lock()
                .map_err(|_| internal("Database lock poisoned"))?;
            work(&mut connection)
        })
        .await
        .map_err(internal)?
    }
}

#[derive(Clone)]
pub struct SubmissionState {
    store: Store,
    catalog: Arc<Value>,
    builtin_ids: Arc<HashSet<String>>,
    builtin_banks: Arc<HashSet<String>>,
    shell: Arc<String>,
    admin_token: Option<Arc<str>>,
}
impl SubmissionState {
    pub fn new(
        store: Store,
        catalog: Value,
        shell: String,
        admin_token: Option<String>,
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
        {
            let connection = store
                .0
                .lock()
                .map_err(|_| std::io::Error::other("Database lock poisoned"))?;
            let mut statement = connection.prepare("SELECT engine_id,definition FROM submissions WHERE status='published' AND engine_id IS NOT NULL").map_err(std::io::Error::other)?;
            let rows = statement
                .query_map([], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                })
                .map_err(std::io::Error::other)?;
            for row in rows {
                let (engine, definition) = row.map_err(std::io::Error::other)?;
                let builtin = definitions
                    .iter()
                    .find(|def| def["id"] == engine)
                    .ok_or_else(|| {
                        std::io::Error::other(
                            "Published submission references a removed installed engine",
                        )
                    })?;
                crate::validation::engine_contract(
                    &serde_json::from_str::<Value>(&definition).map_err(std::io::Error::other)?,
                    builtin,
                )
                .map_err(std::io::Error::other)?;
            }
            for def in definitions {
                let collision: bool = connection.query_row("SELECT EXISTS(SELECT 1 FROM submissions WHERE status IN ('pending','published') AND (simulation_id=?1 OR json_extract(definition,'$.assessment.id')=?2))", params![def["id"].as_str(), def["assessment"]["id"].as_str()], |row| row.get(0)).map_err(std::io::Error::other)?;
                if collision {
                    return Err(std::io::Error::other(
                        "Built-in catalog conflicts with a pending/published submission; resolve it before deployment",
                    ));
                }
            }
        }
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
        })
    }
    fn authorize(&self, headers: &HeaderMap) -> Result<(), ApiError> {
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

pub fn router(state: SubmissionState) -> Router {
    Router::new()
        .route("/api/submissions/config", get(config))
        .route("/api/submissions/engines", get(engines))
        .route("/api/submissions", post(submit))
        .route("/api/admin/submissions", get(list))
        .route("/api/admin/submissions/{id}", get(detail))
        .route("/api/admin/submissions/{id}/review", post(review))
        .route("/simulations/catalog.json", get(catalog))
        .route("/simulations/{*file}", get(published))
        .layer(DefaultBodyLimit::max(256 * 1024))
        .layer(axum::middleware::map_response(no_cache))
        .with_state(state)
}
async fn no_cache(mut response: Response) -> Response {
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, "no-store".parse().unwrap());
    response
        .headers_mut()
        .insert(header::X_CONTENT_TYPE_OPTIONS, "nosniff".parse().unwrap());
    response
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
struct Submission {
    definition: Value,
    #[serde(default)]
    engine_id: Option<String>,
    #[serde(default)]
    module_code: Option<String>,
    #[serde(default)]
    submitted_by: String,
}
async fn submit(
    State(state): State<SubmissionState>,
    Json(input): Json<Submission>,
) -> Result<impl IntoResponse, ApiError> {
    if state.admin_token.is_none() {
        return Err(error(
            StatusCode::SERVICE_UNAVAILABLE,
            "Submissions are disabled until a reviewer is configured",
        ));
    }
    let definition = input.definition.to_string();
    if definition.len() > MAX_DEFINITION {
        return Err(error(
            StatusCode::PAYLOAD_TOO_LARGE,
            "Definition exceeds 64 KiB",
        ));
    }
    crate::validation::validate(&input.definition)
        .map_err(|message| error(StatusCode::UNPROCESSABLE_ENTITY, message))?;
    let id = input.definition["id"].as_str().unwrap().to_owned();
    if state.builtin_ids.contains(&id)
        || input.definition["assessment"]["id"]
            .as_str()
            .is_some_and(|bank| state.builtin_banks.contains(bank))
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
        (None, Some(code)) if !code.trim().is_empty() && code.len() <= MAX_MODULE => {}
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
    let receipt = state.store.run(move |connection| {
        // IMMEDIATE serializes quotas + insertion across multiple server processes too.
        let transaction = connection.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate).map_err(internal)?;
        let (total, recent, pending): (i64, i64, i64) = transaction.query_row("SELECT COUNT(*), COALESCE(SUM(created_at >= strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 hour')),0), COALESCE(SUM(status='pending'),0) FROM submissions", [], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?))).map_err(internal)?;
        if total >= 2000 || recent >= 100 || pending >= 500 { return Err(error(StatusCode::TOO_MANY_REQUESTS, "Submission queue is full; please try again later")); }
        transaction.execute("INSERT INTO submissions (simulation_id,definition,engine_id,module_code,submitted_by) VALUES (?1,?2,?3,?4,?5)", params![id, definition, input.engine_id, input.module_code, input.submitted_by.trim()]).map_err(|err| {
            if matches!(err, rusqlite::Error::SqliteFailure(ref code, _) if code.code == rusqlite::ErrorCode::ConstraintViolation) { error(StatusCode::CONFLICT, "Simulation or assessment ID has already been submitted; choose a new ID") } else { internal(err) }
        })?;
        let receipt = transaction.last_insert_rowid(); transaction.commit().map_err(internal)?;
        Ok(receipt)
    }).await?;
    Ok((
        StatusCode::CREATED,
        Json(json!({"id":receipt,"status":"pending"})),
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
    if !["pending", "published", "rejected", "withdrawn"].contains(&status.as_str())
        || query.before.is_some_and(|id| id <= 0)
    {
        return Err(error(StatusCode::BAD_REQUEST, "Invalid queue filter"));
    }
    let items = state.store.run(move |connection| {
        let mut statement = connection.prepare("SELECT id, simulation_id, json_extract(definition,'$.title'), submitted_by, status, created_at, reviewed_at, review_note, module_code IS NOT NULL FROM submissions WHERE status=?1 AND (?2 IS NULL OR id < ?2) ORDER BY id DESC LIMIT 21").map_err(internal)?;
        let rows = statement.query_map(params![status, query.before], |row| Ok(json!({"id":row.get::<_,i64>(0)?,"simulationId":row.get::<_,String>(1)?,"title":row.get::<_,String>(2)?,"submittedBy":row.get::<_,String>(3)?,"status":row.get::<_,String>(4)?,"createdAt":row.get::<_,String>(5)?,"reviewedAt":row.get::<_,Option<String>>(6)?,"reviewNote":row.get::<_,String>(7)?,"hasCode":row.get::<_,bool>(8)?}))).map_err(internal)?;
        rows.collect::<rusqlite::Result<Vec<_>>>().map_err(internal)
    }).await?;
    let has_more = items.len() > 20;
    Ok(Json(
        json!({"items":items.into_iter().take(20).collect::<Vec<_>>(), "hasMore":has_more}),
    ))
}
async fn detail(
    State(state): State<SubmissionState>,
    headers: HeaderMap,
    RoutePath(id): RoutePath<i64>,
) -> Result<Json<Value>, ApiError> {
    state.authorize(&headers)?;
    let item = state.store.run(move |connection| {
        connection.query_row("SELECT definition, engine_id, module_code, submitted_by, status, review_note FROM submissions WHERE id=?1", [id], |row| Ok((row.get::<_,String>(0)?, row.get::<_,Option<String>>(1)?,row.get::<_,Option<String>>(2)?,row.get::<_,String>(3)?,row.get::<_,String>(4)?,row.get::<_,String>(5)?))).optional().map_err(internal)?.ok_or_else(not_found)
    }).await?;
    Ok(Json(
        json!({"id":id,"definition":serde_json::from_str::<Value>(&item.0).map_err(internal)?,"engineId":item.1,"moduleCode":item.2,"submittedBy":item.3,"status":item.4,"reviewNote":item.5}),
    ))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Review {
    decision: String,
    #[serde(default)]
    code_reviewed: bool,
    #[serde(default)]
    note: String,
}
async fn review(
    State(state): State<SubmissionState>,
    headers: HeaderMap,
    RoutePath(id): RoutePath<i64>,
    Json(input): Json<Review>,
) -> Result<Json<Value>, ApiError> {
    state.authorize(&headers)?;
    if !["publish", "reject", "withdraw"].contains(&input.decision.as_str())
        || input.note.chars().count() > 1000
    {
        return Err(error(
            StatusCode::UNPROCESSABLE_ENTITY,
            "Invalid review decision or note (maximum 1000 characters)",
        ));
    }
    if input.decision != "publish" && input.note.trim().is_empty() {
        return Err(error(
            StatusCode::UNPROCESSABLE_ENTITY,
            "Explain why the submission was rejected or withdrawn",
        ));
    }
    let builtin_catalog = state.catalog.clone();
    let status = state.store.run(move |connection| {
        let transaction = connection.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate).map_err(internal)?;
        let (current, definition, has_code, engine): (String,String,bool,Option<String>) = transaction.query_row("SELECT status,definition,module_code IS NOT NULL,engine_id FROM submissions WHERE id=?1", [id], |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?))).optional().map_err(internal)?.ok_or_else(not_found)?;
        let required = if input.decision == "withdraw" { "published" } else { "pending" };
        if current != required { return Err(error(StatusCode::CONFLICT, "Submission is no longer in the required review state; refresh the queue")); }
        if input.decision == "publish" {
            if has_code && !input.code_reviewed { return Err(error(StatusCode::UNPROCESSABLE_ENTITY, "Publishing new engine code requires explicit confirmation of a trusted code review")); }
            let definition = serde_json::from_str::<Value>(&definition).map_err(internal)?;
            crate::validation::validate(&definition).map_err(|message| error(StatusCode::UNPROCESSABLE_ENTITY, message))?;
            if let Some(engine) = engine {
                let builtin = builtin_catalog["simulations"].as_array().unwrap().iter().find(|def| def["id"] == engine).ok_or_else(|| error(StatusCode::UNPROCESSABLE_ENTITY, "Installed engine is no longer available"))?;
                crate::validation::engine_contract(&definition, builtin).map_err(|message| error(StatusCode::UNPROCESSABLE_ENTITY, message))?;
            }
        }
        let status = match input.decision.as_str() { "publish" => "published", "reject" => "rejected", _ => "withdrawn" };
        transaction.execute("UPDATE submissions SET status=?1,review_note=?2,reviewed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?3", params![status,input.note.trim(),id]).map_err(internal)?;
        transaction.commit().map_err(internal)?;
        Ok(status)
    }).await?;
    Ok(Json(json!({"id":id,"status":status})))
}

async fn catalog(State(state): State<SubmissionState>) -> Result<Json<Value>, ApiError> {
    let definitions = state
        .store
        .run(|connection| {
            let mut statement = connection
                .prepare("SELECT definition FROM submissions WHERE status='published' ORDER BY id")
                .map_err(internal)?;
            let rows = statement
                .query_map([], |row| row.get::<_, String>(0))
                .map_err(internal)?;
            rows.map(|row| serde_json::from_str::<Value>(&row.map_err(internal)?).map_err(internal))
                .collect::<Result<Vec<_>, _>>()
        })
        .await?;
    let mut catalog = (*state.catalog).clone();
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
    let item = state.store.run(move |connection| {
        connection.query_row("SELECT engine_id,module_code FROM submissions WHERE simulation_id=?1 AND status='published'", [id], |row| Ok((row.get::<_,Option<String>>(0)?,row.get::<_,Option<String>>(1)?))).optional().map_err(internal)?.ok_or_else(not_found)
    }).await?;
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

struct ApiError(StatusCode, String);
fn error(status: StatusCode, message: impl Into<String>) -> ApiError {
    ApiError(status, message.into())
}
fn not_found() -> ApiError {
    error(StatusCode::NOT_FOUND, "Not found")
}
fn internal(error: impl std::fmt::Display) -> ApiError {
    tracing::error!(%error, "Submission storage operation failed");
    error_response()
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
