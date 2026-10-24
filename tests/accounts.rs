use axum::{
    Router,
    body::{Body, to_bytes},
    http::{Request, StatusCode, header},
    response::Response,
};
use commonlab::{AppConfig, Store, app_with_config};
use serde_json::{Value, json};
use std::{
    path::PathBuf,
    time::{SystemTime, UNIX_EPOCH},
};
use tower::ServiceExt;
struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "commonlab-accounts-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&path).unwrap();
        Self(path)
    }
    fn db(&self) -> PathBuf {
        self.0.join("private.sqlite3")
    }
    fn app(&self, secure: bool) -> Router {
        app_with_config(
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("public"),
            AppConfig {
                admin_token: Some("test-only-administrator-token-00000000".into()),
                secure_cookies: secure,
                ..AppConfig::new(Store::open(self.db()).unwrap())
            },
        )
        .unwrap()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
async fn request(
    app: &Router,
    method: &str,
    path: &str,
    value: Option<Value>,
    cookie: Option<&str>,
    csrf: bool,
) -> Response {
    let mut req = Request::builder().method(method).uri(path);
    if csrf {
        req = req.header("x-commonlab-request", "1");
    }
    if let Some(cookie) = cookie {
        req = req.header(header::COOKIE, cookie);
    }
    let body = if let Some(value) = value {
        req = req.header(header::CONTENT_TYPE, "application/json");
        Body::from(value.to_string())
    } else {
        Body::empty()
    };
    app.clone().oneshot(req.body(body).unwrap()).await.unwrap()
}
async fn json_body(response: Response) -> Value {
    serde_json::from_slice(&to_bytes(response.into_body(), usize::MAX).await.unwrap()).unwrap()
}
fn cookie(response: &Response) -> String {
    response.headers()[header::SET_COOKIE]
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap()
        .to_owned()
}
fn credentials(username: &str) -> Value {
    json!({"username":username,"password":"test-password-with-12-characters"})
}

#[tokio::test]
async fn accounts_passwords_sessions_csrf_persistence_and_ownership() {
    let fixture = Fixture::new();
    let app = fixture.app(false);
    assert_eq!(
        request(
            &app,
            "POST",
            "/api/auth/register",
            Some(credentials("alice")),
            None,
            false
        )
        .await
        .status(),
        StatusCode::FORBIDDEN
    );
    for input in [
        json!({"username":"alice","password":"short"}),
        credentials("../bad"),
        json!({"username":"alice","password":"test-password-with-12-characters","admin":true}),
    ] {
        assert_eq!(
            request(&app, "POST", "/api/auth/register", Some(input), None, true)
                .await
                .status(),
            StatusCode::UNPROCESSABLE_ENTITY
        );
    }
    let registered = request(
        &app,
        "POST",
        "/api/auth/register",
        Some(credentials("Alice")),
        None,
        true,
    )
    .await;
    assert_eq!(registered.status(), StatusCode::CREATED);
    let flags = registered.headers()[header::SET_COOKIE].to_str().unwrap();
    assert!(
        flags.contains("HttpOnly") && flags.contains("SameSite=Strict") && flags.contains("Path=/")
    );
    assert_eq!(registered.headers()[header::CACHE_CONTROL], "no-store");
    let first = cookie(&registered);
    let account = json_body(registered).await;
    assert_eq!(account["username"], "alice");
    assert!(account.get("password_hash").is_none());
    let connection = rusqlite::Connection::open(fixture.db()).unwrap();
    let hash: String = connection
        .query_row("SELECT password_hash FROM contributors", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert!(hash.starts_with("$argon2id$"));
    assert!(!hash.contains("test-password"));
    let stored: String = connection
        .query_row("SELECT token_hash FROM contributor_sessions", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert_ne!(stored, first.split_once('=').unwrap().1);
    assert_eq!(
        request(
            &app,
            "POST",
            "/api/auth/register",
            Some(credentials("ALICE")),
            None,
            true
        )
        .await
        .status(),
        StatusCode::CONFLICT
    );
    let mut bad = credentials("alice");
    bad["password"] = json!("wrong-password-but-long");
    let denied = request(&app, "POST", "/api/auth/login", Some(bad), None, true).await;
    let unknown = request(
        &app,
        "POST",
        "/api/auth/login",
        Some(credentials("nobody")),
        None,
        true,
    )
    .await;
    assert_eq!(denied.status(), StatusCode::UNAUTHORIZED);
    assert_eq!(json_body(denied).await, json_body(unknown).await);
    let logged = request(
        &app,
        "POST",
        "/api/auth/login",
        Some(credentials("alice")),
        Some(&first),
        true,
    )
    .await;
    assert_eq!(logged.status(), StatusCode::OK);
    let second = cookie(&logged);
    assert_ne!(second, first);
    assert_eq!(
        request(&app, "GET", "/api/auth/me", None, Some(&first), false)
            .await
            .status(),
        StatusCode::UNAUTHORIZED
    );
    let restarted = fixture.app(false);
    assert_eq!(
        json_body(
            request(
                &restarted,
                "GET",
                "/api/auth/me",
                None,
                Some(&second),
                false
            )
            .await
        )
        .await["username"],
        "alice"
    );
    let def = json!({"id":"owned-lab","title":"Owned lab","subject":"physics","summary":"A scientific relationship.","canvas":{"id":"scene","label":"Scene","width":700,"height":480},"controls":[],"cards":[],"graphs":[],"lessons":[]});
    let draft = json!({"definition":def,"moduleCode":"export function mount(ui) {}","submittedBy":"Not an identity claim"});
    assert_eq!(
        request(
            &app,
            "POST",
            "/api/submissions",
            Some(draft.clone()),
            None,
            true
        )
        .await
        .status(),
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        request(
            &app,
            "POST",
            "/api/submissions",
            Some(draft.clone()),
            Some(&second),
            false
        )
        .await
        .status(),
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        request(
            &app,
            "POST",
            "/api/submissions",
            Some(draft),
            Some(&second),
            true
        )
        .await
        .status(),
        StatusCode::CREATED
    );
    let owner: i64 = connection
        .query_row("SELECT contributor_id FROM submissions", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!(owner, account["id"].as_i64().unwrap());
    assert_eq!(
        request(
            &app,
            "GET",
            "/api/admin/submissions",
            None,
            Some(&second),
            false
        )
        .await
        .status(),
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        request(&app, "POST", "/api/auth/logout", None, Some(&second), false)
            .await
            .status(),
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        request(&app, "POST", "/api/auth/logout", None, Some(&second), true)
            .await
            .status(),
        StatusCode::OK
    );
    assert_eq!(
        request(&app, "GET", "/api/auth/me", None, Some(&second), false)
            .await
            .status(),
        StatusCode::UNAUTHORIZED
    );
    let secure = fixture.app(true);
    let logged = request(
        &secure,
        "POST",
        "/api/auth/login",
        Some(credentials("alice")),
        None,
        true,
    )
    .await;
    let secure_cookie = cookie(&logged);
    assert!(secure_cookie.starts_with("__Host-cl_session="));
    assert!(
        logged.headers()[header::SET_COOKIE]
            .to_str()
            .unwrap()
            .contains("; Secure")
    );
    connection
        .execute(
            "UPDATE contributor_sessions SET expires_at=unixepoch()-1",
            [],
        )
        .unwrap();
    assert_eq!(
        request(
            &secure,
            "GET",
            "/api/auth/me",
            None,
            Some(&secure_cookie),
            false
        )
        .await
        .status(),
        StatusCode::UNAUTHORIZED
    );
    connection.execute("INSERT INTO auth_attempts(username) SELECT 'throttled' FROM (SELECT 1) a CROSS JOIN (SELECT 1 UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4 UNION ALL SELECT 5) b CROSS JOIN (SELECT 1 UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4) c",[]).unwrap();
    assert_eq!(
        request(
            &app,
            "POST",
            "/api/auth/login",
            Some(credentials("throttled")),
            None,
            true
        )
        .await
        .status(),
        StatusCode::TOO_MANY_REQUESTS
    );
}

#[test]
fn migrates_version_one_without_claiming_or_losing_legacy_submissions() {
    let fixture = Fixture::new();
    let connection = rusqlite::Connection::open(fixture.db()).unwrap();
    connection.execute_batch("CREATE TABLE submissions(id INTEGER PRIMARY KEY,simulation_id TEXT NOT NULL UNIQUE,definition TEXT NOT NULL,engine_id TEXT,module_code TEXT,submitted_by TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending',created_at TEXT NOT NULL DEFAULT '',reviewed_at TEXT,review_note TEXT NOT NULL DEFAULT ''); INSERT INTO submissions(simulation_id,definition,module_code,submitted_by) VALUES ('legacy-lab','{}','legacy source','old anonymous name'); PRAGMA user_version=1;").unwrap();
    drop(connection);
    let _store = Store::open(fixture.db()).unwrap();
    let connection = rusqlite::Connection::open(fixture.db()).unwrap();
    let owner: Option<i64> = connection
        .query_row("SELECT contributor_id FROM submissions", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert!(owner.is_none());
    assert_eq!(
        connection
            .query_row::<String, _, _>("SELECT module_code FROM submissions", [], |row| row.get(0))
            .unwrap(),
        "legacy source"
    );
    assert_eq!(
        connection
            .pragma_query_value::<u32, _>(None, "user_version", |row| row.get(0))
            .unwrap(),
        9
    );
    drop(_store);
    Store::open(fixture.db()).unwrap();
}
