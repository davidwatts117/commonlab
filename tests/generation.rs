use axum::{
    Router,
    body::{Body, to_bytes},
    http::{Request, StatusCode},
    response::Response,
};
use commonlab::{GenerationConfig, Store, app_with_generation};
use serde_json::{Value, json};
use tower::ServiceExt;
const ADMIN: &str = "generation-test-admin-token-000000000";
const WORKER: &str = "generation-test-worker-token-00000000";
async fn req(
    app: &Router,
    path: &str,
    method: &str,
    body: Option<Value>,
    cookie: Option<&str>,
    bearer: Option<&str>,
    csrf: bool,
) -> Response {
    let mut r = Request::builder().method(method).uri(path);
    if let Some(cookie) = cookie {
        r = r.header("Cookie", cookie);
    }
    if let Some(token) = bearer {
        r = r.header("Authorization", format!("Bearer {token}"));
    }
    if csrf {
        r = r.header("X-CommonLab-Request", "1");
    }
    let b = if let Some(body) = body {
        r = r.header("Content-Type", "application/json");
        Body::from(body.to_string())
    } else {
        Body::empty()
    };
    app.clone().oneshot(r.body(b).unwrap()).await.unwrap()
}
async fn val(r: Response) -> Value {
    serde_json::from_slice(&to_bytes(r.into_body(), usize::MAX).await.unwrap()).unwrap()
}
async fn register(app: &Router, name: &str) -> String {
    let r = req(
        app,
        "/api/auth/register",
        "POST",
        Some(json!({"username":name,"password":"test-generation-password-123"})),
        None,
        None,
        true,
    )
    .await;
    assert_eq!(r.status(), StatusCode::CREATED);
    r.headers()["set-cookie"]
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap()
        .to_owned()
}
async fn grant(app: &Router, name: &str, allowed: bool) -> Response {
    req(
        app,
        "/api/admin/generation/access",
        "POST",
        Some(json!({"username":name,"allowed":allowed})),
        None,
        Some(ADMIN),
        false,
    )
    .await
}
async fn create(app: &Router, cookie: &str) -> Response {
    req(
        app,
        "/api/generation/jobs",
        "POST",
        Some(
            json!({"prompt":"A spring lab for students <literal>","acceptProviderProcessing":true}),
        ),
        Some(cookie),
        None,
        true,
    )
    .await
}
fn def(id: &Value) -> Value {
    json!({"id":id,"title":"Generated lab","subject":"physics","summary":"An inert generated draft.","canvas":{"id":"scene","label":"Scene","width":640,"height":400},"controls":[],"cards":[],"graphs":[],"lessons":[]})
}
#[tokio::test]
async fn opt_in_worker_leases_private_artifacts_revocation_and_quotas() {
    let app = app_with_generation(
        "public",
        Store::memory().unwrap(),
        Some(ADMIN.into()),
        false,
        Some(GenerationConfig::new(WORKER.into()).unwrap()),
    )
    .unwrap();
    let alice = register(&app, "alice").await;
    let bob = register(&app, "bob").await;
    assert_eq!(create(&app, &alice).await.status(), StatusCode::FORBIDDEN);
    assert_eq!(
        req(
            &app,
            "/api/admin/generation/access",
            "POST",
            Some(json!({"username":"alice","allowed":true})),
            Some(&alice),
            None,
            true
        )
        .await
        .status(),
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(grant(&app, "alice", true).await.status(), StatusCode::OK);
    assert_eq!(
        req(
            &app,
            "/api/generation/jobs",
            "POST",
            Some(json!({"prompt":"test","acceptProviderProcessing":true})),
            Some(&alice),
            None,
            false
        )
        .await
        .status(),
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        req(
            &app,
            "/api/generation/jobs",
            "POST",
            Some(json!({"prompt":"test","acceptProviderProcessing":false})),
            Some(&alice),
            None,
            true
        )
        .await
        .status(),
        StatusCode::UNPROCESSABLE_ENTITY
    );
    let r = create(&app, &alice).await;
    assert_eq!(r.status(), StatusCode::ACCEPTED);
    let id = val(r).await["id"].as_i64().unwrap();
    let path = format!("/api/generation/jobs/{id}");
    assert_eq!(
        create(&app, &alice).await.status(),
        StatusCode::TOO_MANY_REQUESTS
    );
    assert_eq!(
        req(&app, &path, "GET", None, Some(&bob), None, false)
            .await
            .status(),
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        req(&app, &path, "GET", None, None, None, false)
            .await
            .status(),
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        req(
            &app,
            "/api/worker/generation/claim",
            "POST",
            None,
            Some(&alice),
            None,
            true
        )
        .await
        .status(),
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        req(
            &app,
            "/api/admin/submissions",
            "GET",
            None,
            None,
            Some(WORKER),
            false
        )
        .await
        .status(),
        StatusCode::UNAUTHORIZED
    );
    let job = val(req(
        &app,
        "/api/worker/generation/claim",
        "POST",
        None,
        None,
        Some(WORKER),
        false,
    )
    .await)
    .await;
    assert_eq!(job["id"], id);
    assert!(job.get("contributorId").is_none());
    assert!(job.get("username").is_none());
    assert!(
        val(req(
            &app,
            "/api/worker/generation/claim",
            "POST",
            None,
            None,
            Some(WORKER),
            false
        )
        .await)
        .await
        .is_null()
    );
    let engine = "export function mount(ui) { globalThis.generatedCodeExecuted = true; return { app: {} }; }";
    let body = json!({"lease":job["lease"],"model":"test/no-paid-model","artifact":{"definition":def(&job["simulationId"]),"moduleCode":engine}});
    let mut wrong = body.clone();
    wrong["lease"] = json!("wrong");
    assert_eq!(
        req(
            &app,
            &format!("/api/worker/generation/{id}/complete"),
            "POST",
            Some(wrong),
            None,
            Some(WORKER),
            false
        )
        .await
        .status(),
        StatusCode::CONFLICT
    );
    assert_eq!(
        req(
            &app,
            &format!("/api/worker/generation/{id}/complete"),
            "POST",
            Some(body.clone()),
            None,
            Some(WORKER),
            false
        )
        .await
        .status(),
        StatusCode::OK
    );
    assert_eq!(
        req(
            &app,
            &format!("/api/worker/generation/{id}/complete"),
            "POST",
            Some(body),
            None,
            Some(WORKER),
            false
        )
        .await
        .status(),
        StatusCode::CONFLICT
    );
    let r = req(&app, &path, "GET", None, Some(&alice), None, false).await;
    assert_eq!(r.headers()["cache-control"], "no-store");
    let result = val(r).await;
    assert_eq!(result["status"], "succeeded");
    assert_eq!(result["artifact"]["source"]["moduleCode"], engine);
    assert_eq!(
        req(
            &app,
            &format!("/simulations/{}.js", job["simulationId"].as_str().unwrap()),
            "GET",
            None,
            None,
            None,
            false
        )
        .await
        .status(),
        StatusCode::NOT_FOUND
    );
    let queue = val(req(
        &app,
        "/api/admin/submissions?status=pending",
        "GET",
        None,
        None,
        Some(ADMIN),
        false,
    )
    .await)
    .await;
    assert!(queue["items"].as_array().unwrap().is_empty());
    let list = val(req(
        &app,
        "/api/generation/jobs",
        "GET",
        None,
        Some(&alice),
        None,
        false,
    )
    .await)
    .await;
    assert!(!list.to_string().contains("generatedCodeExecuted"));
    assert!(!list.to_string().contains("<literal>"));
    let id2 = val(create(&app, &alice).await).await["id"]
        .as_i64()
        .unwrap();
    let job2 = val(req(
        &app,
        "/api/worker/generation/claim",
        "POST",
        None,
        None,
        Some(WORKER),
        false,
    )
    .await)
    .await;
    assert_eq!(grant(&app, "alice", false).await.status(), StatusCode::OK);
    let check = val(req(
        &app,
        &format!("/api/worker/generation/{id2}/check"),
        "POST",
        Some(json!({"lease":job2["lease"]})),
        None,
        Some(WORKER),
        false,
    )
    .await)
    .await;
    assert_eq!(check["active"], false);
    let result = val(req(
        &app,
        &format!("/api/generation/jobs/{id2}"),
        "GET",
        None,
        Some(&alice),
        None,
        false,
    )
    .await)
    .await;
    assert_eq!(result["status"], "cancelled");
    assert_eq!(create(&app, &alice).await.status(), StatusCode::FORBIDDEN);
    grant(&app, "alice", true).await;
    let id3 = val(create(&app, &alice).await).await["id"]
        .as_i64()
        .unwrap();
    assert_eq!(
        req(
            &app,
            &format!("/api/generation/jobs/{id3}/cancel"),
            "POST",
            None,
            Some(&bob),
            None,
            true
        )
        .await
        .status(),
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        req(
            &app,
            &format!("/api/generation/jobs/{id3}/cancel"),
            "POST",
            None,
            Some(&alice),
            None,
            true
        )
        .await
        .status(),
        StatusCode::OK
    );
    assert_eq!(
        create(&app, &alice).await.status(),
        StatusCode::TOO_MANY_REQUESTS
    );
}
#[tokio::test]
async fn permissions_and_leases_survive_restart_and_expired_work_cannot_complete() {
    let dir = std::env::temp_dir().join(format!(
        "commonlab-generation-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    let db = dir.join("jobs.sqlite3");
    let make = || {
        app_with_generation(
            "public",
            Store::open(&db).unwrap(),
            Some(ADMIN.into()),
            false,
            Some(GenerationConfig::new(WORKER.into()).unwrap()),
        )
        .unwrap()
    };
    let app = make();
    let cookie = register(&app, "alice").await;
    grant(&app, "alice", true).await;
    create(&app, &cookie).await;
    let job = val(req(
        &app,
        "/api/worker/generation/claim",
        "POST",
        None,
        None,
        Some(WORKER),
        false,
    )
    .await)
    .await;
    drop(app);
    let app = make();
    let config = val(req(
        &app,
        "/api/generation/config",
        "GET",
        None,
        Some(&cookie),
        None,
        false,
    )
    .await)
    .await;
    assert_eq!(config["allowed"], true);
    assert!(
        val(req(
            &app,
            "/api/worker/generation/claim",
            "POST",
            None,
            None,
            Some(WORKER),
            false
        )
        .await)
        .await
        .is_null()
    );
    let connection = rusqlite::Connection::open(&db).unwrap();
    let hash: String = connection
        .query_row("SELECT lease_hash FROM generation_jobs", [], |r| r.get(0))
        .unwrap();
    assert_ne!(hash, job["lease"].as_str().unwrap());
    connection
        .execute("UPDATE generation_jobs SET lease_expires=0", [])
        .unwrap();
    drop(connection);
    let id = job["id"].as_i64().unwrap();
    let r = req(
        &app,
        &format!("/api/worker/generation/{id}/complete"),
        "POST",
        Some(json!({"lease":job["lease"],"model":"scripted/test","artifact":null})),
        None,
        Some(WORKER),
        false,
    )
    .await;
    assert_eq!(r.status(), StatusCode::CONFLICT);
    let result = val(req(
        &app,
        &format!("/api/generation/jobs/{id}"),
        "GET",
        None,
        Some(&cookie),
        None,
        false,
    )
    .await)
    .await;
    assert_eq!(result["status"], "failed");
    assert_eq!(create(&app, &cookie).await.status(), StatusCode::ACCEPTED);
    drop(app);
    std::fs::remove_dir_all(dir).unwrap();
}
#[tokio::test]
async fn generation_defaults_off_and_tokens_are_separate() {
    let app = app_with_generation(
        "public",
        Store::memory().unwrap(),
        Some(ADMIN.into()),
        false,
        None,
    )
    .unwrap();
    let cookie = register(&app, "alice").await;
    assert_eq!(
        create(&app, &cookie).await.status(),
        StatusCode::SERVICE_UNAVAILABLE
    );
    let config = val(req(
        &app,
        "/api/generation/config",
        "GET",
        None,
        Some(&cookie),
        None,
        false,
    )
    .await)
    .await;
    assert_eq!(config["enabled"], false);
    assert_eq!(config["allowed"], false);
    assert!(GenerationConfig::new("weak".into()).is_err());
    assert!(
        app_with_generation(
            "public",
            Store::memory().unwrap(),
            Some(ADMIN.into()),
            false,
            Some(GenerationConfig::new(ADMIN.into()).unwrap())
        )
        .is_err()
    );
}
