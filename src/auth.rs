//! Passwords are Argon2id hashes. Only digests of random, expiring session tokens enter SQLite.
use crate::submissions::{ApiError, Store, conflict_or_internal, error, internal, no_cache};
use argon2::{
    Argon2,
    password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString},
};
use axum::{
    Json, Router,
    extract::{DefaultBodyLimit, State},
    http::{HeaderMap, StatusCode, header},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use rand_core::{OsRng, RngCore};
use rusqlite::{OptionalExtension, params};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::sync::{Arc, LazyLock};
use tokio::sync::Semaphore;
const SESSION_SECONDS: i64 = 7 * 24 * 3600;
static HASH_WORKERS: LazyLock<Arc<Semaphore>> = LazyLock::new(|| Arc::new(Semaphore::new(4)));
static DUMMY_HASH: LazyLock<String> = LazyLock::new(|| {
    hash_password("not-a-real-contributor-password")
        .expect("Argon2 and operating system RNG available")
});

#[derive(Clone)]
struct AuthState {
    store: Store,
    secure: bool,
}
#[derive(Serialize)]
pub(crate) struct Account {
    pub id: i64,
    pub username: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Credentials {
    username: String,
    password: String,
}

pub fn router(store: Store, secure: bool) -> Router {
    Router::new()
        .route("/api/auth/register", post(register))
        .route("/api/auth/login", post(login))
        .route("/api/auth/logout", post(logout))
        .route("/api/auth/me", get(me))
        .layer(DefaultBodyLimit::max(8192))
        .layer(axum::middleware::map_response(no_cache))
        .with_state(AuthState { store, secure })
}
pub(crate) fn csrf(headers: &HeaderMap) -> Result<(), ApiError> {
    // Custom headers require a same-origin request or successful CORS preflight; we enable no CORS.
    if headers
        .get("x-commonlab-request")
        .is_none_or(|value| value != "1")
    {
        return Err(error(
            StatusCode::FORBIDDEN,
            "A same-origin contributor request is required",
        ));
    }
    Ok(())
}
fn cookie_name(secure: bool) -> &'static str {
    if secure {
        "__Host-cl_session"
    } else {
        "cl_session"
    }
}
fn token(headers: &HeaderMap, secure: bool) -> Option<String> {
    let mut found = None;
    for line in headers.get_all(header::COOKIE) {
        for cookie in line.to_str().ok()?.split(';') {
            let Some((name, value)) = cookie.trim().split_once('=') else {
                continue;
            };
            if name == cookie_name(secure) {
                if found.is_some()
                    || value.len() != 64
                    || !value.bytes().all(|ch| ch.is_ascii_hexdigit())
                {
                    return None;
                }
                found = Some(value.to_owned());
            }
        }
    }
    found
}
/// Tokens are stored and compared only as SHA-256 digests.
pub(crate) fn digest(token: &str) -> String {
    format!("{:x}", Sha256::digest(token.as_bytes()))
}
/// 256 bits from the operating system RNG, hex-encoded.
pub(crate) fn random_hex() -> Result<String, ApiError> {
    let mut bytes = [0u8; 32];
    OsRng
        .try_fill_bytes(&mut bytes)
        .map_err(|_| internal("Operating system random generator unavailable"))?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}
fn hash_password(password: &str) -> Result<String, ApiError> {
    let mut salt = [0u8; 16];
    OsRng
        .try_fill_bytes(&mut salt)
        .map_err(|_| internal("Operating system random generator unavailable"))?;
    let salt = SaltString::encode_b64(&salt).map_err(internal)?;
    Argon2::default()
        .hash_password(password.as_bytes(), &salt)
        .map(|hash| hash.to_string())
        .map_err(internal)
}
fn normalize(input: Credentials) -> Result<Credentials, ApiError> {
    let username = input.username.trim().to_ascii_lowercase();
    if !(3..=32).contains(&username.len())
        || !username.as_bytes()[0].is_ascii_lowercase()
        || !username
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || b"_-".contains(&byte))
    {
        return Err(error(
            StatusCode::UNPROCESSABLE_ENTITY,
            "Username must be 3–32 lowercase letters, digits, underscores or hyphens, starting with a letter",
        ));
    }
    if input.password.chars().count() < 12 || input.password.len() > 256 {
        return Err(error(
            StatusCode::UNPROCESSABLE_ENTITY,
            "Password must have at least 12 characters and at most 256 UTF-8 bytes",
        ));
    }
    Ok(Credentials {
        username,
        password: input.password,
    })
}
async fn throttle(store: &Store, username: String) -> Result<(), ApiError> {
    store
        .run(move |connection| {
            let tx = connection
                .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
                .map_err(internal)?;
            tx.execute(
                "DELETE FROM auth_attempts WHERE created_at < unixepoch() - 3600",
                [],
            )
            .map_err(internal)?;
            let (global, user): (i64, i64) = tx
                .query_row(
                    "SELECT COUNT(*), \
                     COALESCE(SUM(username = ?1 AND created_at >= unixepoch() - 600), 0) \
                     FROM auth_attempts",
                    [&username],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .map_err(internal)?;
            if global >= 500 || user >= 20 {
                return Err(error(
                    StatusCode::TOO_MANY_REQUESTS,
                    "Too many authentication attempts; try again later",
                ));
            }
            tx.execute(
                "INSERT INTO auth_attempts(username) VALUES (?1)",
                [&username],
            )
            .map_err(internal)?;
            tx.commit().map_err(internal)
        })
        .await
}
pub(crate) async fn account(
    store: &Store,
    headers: &HeaderMap,
    secure: bool,
) -> Result<Account, ApiError> {
    let raw = token(headers, secure).ok_or_else(unauthorized)?;
    let hash = digest(&raw);
    store
        .run(move |connection| {
            connection
                .query_row(
                    "SELECT c.id, c.username FROM contributors c \
                     JOIN contributor_sessions s ON s.contributor_id = c.id \
                     WHERE s.token_hash = ?1 AND s.expires_at > unixepoch()",
                    [hash],
                    |row| {
                        Ok(Account {
                            id: row.get(0)?,
                            username: row.get(1)?,
                        })
                    },
                )
                .optional()
                .map_err(internal)?
                .ok_or_else(unauthorized)
        })
        .await
}
fn unauthorized() -> ApiError {
    error(
        StatusCode::UNAUTHORIZED,
        "Sign in to your contributor account",
    )
}
async fn session(
    state: &AuthState,
    account: Account,
    old: Option<String>,
    status: StatusCode,
) -> Result<Response, ApiError> {
    let raw = random_hex()?;
    let hash = digest(&raw);
    let id = account.id;
    state
        .store
        .run(move |connection| {
            let tx = connection
                .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
                .map_err(internal)?;
            tx.execute(
                "DELETE FROM contributor_sessions WHERE expires_at <= unixepoch()",
                [],
            )
            .map_err(internal)?;
            if let Some(old) = old {
                tx.execute(
                    "DELETE FROM contributor_sessions WHERE token_hash = ?1",
                    [digest(&old)],
                )
                .map_err(internal)?;
            }
            // Keep the seven newest sessions, so with the new one an account has at most eight.
            tx.execute(
                "DELETE FROM contributor_sessions WHERE contributor_id = ?1 AND token_hash NOT IN \
                 (SELECT token_hash FROM contributor_sessions WHERE contributor_id = ?1 \
                  ORDER BY created_at DESC, rowid DESC LIMIT 7)",
                [id],
            )
            .map_err(internal)?;
            tx.execute(
                "INSERT INTO contributor_sessions(token_hash, contributor_id, expires_at) \
                 VALUES (?1, ?2, unixepoch() + ?3)",
                params![hash, id, SESSION_SECONDS],
            )
            .map_err(internal)?;
            tx.commit().map_err(internal)
        })
        .await?;
    let cookie = format!(
        "{}={raw}; Path=/; HttpOnly; SameSite=Strict; Max-Age={SESSION_SECONDS}{}",
        cookie_name(state.secure),
        if state.secure { "; Secure" } else { "" }
    );
    Ok((status, [(header::SET_COOKIE, cookie)], Json(account)).into_response())
}
async fn register(
    State(state): State<AuthState>,
    headers: HeaderMap,
    Json(input): Json<Credentials>,
) -> Result<Response, ApiError> {
    csrf(&headers)?;
    let input = normalize(input)?;
    throttle(&state.store, input.username.clone()).await?;
    let permit = HASH_WORKERS.clone().try_acquire_owned().map_err(|_| {
        error(
            StatusCode::TOO_MANY_REQUESTS,
            "Authentication is busy; try again shortly",
        )
    })?;
    let username = input.username;
    let hash = tokio::task::spawn_blocking(move || {
        let _permit = permit;
        hash_password(&input.password)
    })
    .await
    .map_err(internal)??;
    let account = state
        .store
        .run(move |connection| {
            let tx = connection
                .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
                .map_err(internal)?;
            let total: i64 = tx
                .query_row("SELECT COUNT(*) FROM contributors", [], |row| row.get(0))
                .map_err(internal)?;
            if total >= 10000 {
                return Err(error(
                    StatusCode::TOO_MANY_REQUESTS,
                    "Registration capacity reached",
                ));
            }
            tx.execute(
                "INSERT INTO contributors(username, password_hash) VALUES (?1, ?2)",
                params![username, hash],
            )
            .map_err(|err| conflict_or_internal(err, "Username is already in use"))?;
            let id = tx.last_insert_rowid();
            tx.commit().map_err(internal)?;
            Ok(Account { id, username })
        })
        .await?;
    session(
        &state,
        account,
        token(&headers, state.secure),
        StatusCode::CREATED,
    )
    .await
}
async fn login(
    State(state): State<AuthState>,
    headers: HeaderMap,
    Json(input): Json<Credentials>,
) -> Result<Response, ApiError> {
    csrf(&headers)?;
    let input = normalize(input)?;
    throttle(&state.store, input.username.clone()).await?;
    let username = input.username;
    let row = state
        .store
        .run(move |connection| {
            connection
                .query_row(
                    "SELECT id,username,password_hash FROM contributors WHERE username=?1",
                    [username],
                    |row| {
                        Ok((
                            Account {
                                id: row.get(0)?,
                                username: row.get(1)?,
                            },
                            row.get::<_, String>(2)?,
                        ))
                    },
                )
                .optional()
                .map_err(internal)
        })
        .await?;
    let permit = HASH_WORKERS.clone().try_acquire_owned().map_err(|_| {
        error(
            StatusCode::TOO_MANY_REQUESTS,
            "Authentication is busy; try again shortly",
        )
    })?;
    let valid = tokio::task::spawn_blocking(move || {
        let _permit = permit;
        let hash = row
            .as_ref()
            .map(|row| row.1.as_str())
            .unwrap_or(&DUMMY_HASH);
        let parsed = PasswordHash::new(hash).map_err(internal)?;
        if Argon2::default()
            .verify_password(input.password.as_bytes(), &parsed)
            .is_err()
        {
            return Err(error(
                StatusCode::UNAUTHORIZED,
                "Invalid username or password",
            ));
        }
        row.map(|row| row.0)
            .ok_or_else(|| error(StatusCode::UNAUTHORIZED, "Invalid username or password"))
    })
    .await
    .map_err(internal)??;
    session(&state, valid, token(&headers, state.secure), StatusCode::OK).await
}
async fn me(State(state): State<AuthState>, headers: HeaderMap) -> Result<Json<Account>, ApiError> {
    Ok(Json(account(&state.store, &headers, state.secure).await?))
}
async fn logout(State(state): State<AuthState>, headers: HeaderMap) -> Result<Response, ApiError> {
    csrf(&headers)?;
    if let Some(raw) = token(&headers, state.secure) {
        state
            .store
            .run(move |connection| {
                connection
                    .execute(
                        "DELETE FROM contributor_sessions WHERE token_hash=?1",
                        [digest(&raw)],
                    )
                    .map_err(internal)?;
                Ok(())
            })
            .await?;
    }
    let cookie = format!(
        "{}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0{}",
        cookie_name(state.secure),
        if state.secure { "; Secure" } else { "" }
    );
    Ok((
        [(header::SET_COOKIE, cookie)],
        Json(serde_json::json!({"signedOut":true})),
    )
        .into_response())
}
