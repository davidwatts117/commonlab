use axum::{
    Router,
    body::{Body, to_bytes},
    http::{Request, StatusCode},
    response::Response,
};
use commonlab::{AppConfig, GenerationConfig, Store, app_with_config};
use serde_json::{Value, json};
use tower::ServiceExt;
const ADMIN: &str = "generation-test-admin-token-000000000";
const WORKER: &str = "generation-test-worker-token-00000000";
async fn req(
    app: &Router,
    path: &str,
    method: &str,
    mut body: Option<Value>,
    cookie: Option<&str>,
    bearer: Option<&str>,
    csrf: bool,
) -> Response {
    // All fixtures speak the versioned worker protocol; reports below are scripted evidence.
    if path == "/api/worker/generation/claim" && body.is_none() {
        body = Some(json!({"protocolVersion":2}));
    }
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
    // Keep parallel fixtures from exhausting the production password-hashing semaphore.
    static REGISTRATION: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
    let _guard = REGISTRATION.lock().await;
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
async fn activity_is_bounded_private_lease_checked_and_failures_are_safe() {
    let app = app_with_config(
        "public",
        AppConfig {
            admin_token: Some(ADMIN.into()),
            generation: Some(GenerationConfig::new(WORKER.into()).unwrap()),
            ..AppConfig::new(Store::memory().unwrap())
        },
    )
    .unwrap();
    let alice = register(&app, "activity-alice").await;
    let bob = register(&app, "activity-bob").await;
    grant(&app, "activity-alice", true).await;
    let id = val(create(&app, &alice).await).await["id"]
        .as_i64()
        .unwrap();
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
    let path = format!("/api/worker/generation/{id}/progress");
    let read = format!("/api/generation/jobs/{id}/events");
    let diagnostics = json!({"requests":3,"validations":2,"costMicros":20000000,"reasoningEffort":"high","stopReason":"toolUse","phase":"implementation","tool":"submit_draft","toolStatus":"error","issues":[{"path":"/controls/0/value","rule":"required"}]});
    let body = json!({"lease":job["lease"],"code":"validation_failed","details":diagnostics});
    for bad in [
        json!({"rawError":"secret-key"}),
        json!({"phase":"secret-key"}),
        json!({"tool":"bash"}),
        json!({"toolStatus":"secret-key"}),
        json!({"requests":1000000001}),
        json!({"reasoningEffort":"secret-key"}),
        json!({"stopReason":"secret-key"}),
        json!({"issues":[{"path":"/secret-key","rule":"required"}]}),
        json!({"issues":[{"path":"/title","rule":"secret-key"}]}),
    ] {
        assert_eq!(
            req(
                &app,
                &path,
                "POST",
                Some(json!({"lease":job["lease"],"code":"validation_failed","details":bad})),
                None,
                Some(WORKER),
                false
            )
            .await
            .status(),
            StatusCode::UNPROCESSABLE_ENTITY
        );
    }
    assert_eq!(
        req(
            &app,
            &path,
            "POST",
            Some(body.clone()),
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
            &path,
            "POST",
            Some(json!({"lease":"stale","code":"model_request"})),
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
            &path,
            "POST",
            Some(json!({"lease":job["lease"],"code":"secret-raw-error"})),
            None,
            Some(WORKER),
            false
        )
        .await
        .status(),
        StatusCode::UNPROCESSABLE_ENTITY
    );
    for _ in 0..102 {
        assert_eq!(
            req(
                &app,
                &path,
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
    }
    assert_eq!(
        req(&app, &read, "GET", None, Some(&bob), None, false)
            .await
            .status(),
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        req(&app, &read, "GET", None, None, None, false)
            .await
            .status(),
        StatusCode::UNAUTHORIZED
    );
    let response = req(&app, &read, "GET", None, Some(&alice), None, false).await;
    assert_eq!(response.headers()["cache-control"], "no-store");
    assert_eq!(val(response).await["items"].as_array().unwrap().len(), 100);
    assert_eq!(req(&app, &format!("/api/worker/generation/{id}/complete"), "POST", Some(json!({"lease":job["lease"],"model":"test/model","artifact":null,"failure":"timeout","diagnostics":diagnostics})), None, Some(WORKER), false).await.status(), StatusCode::OK);
    let result = val(req(
        &app,
        &format!("/api/generation/jobs/{id}"),
        "GET",
        None,
        Some(&alice),
        None,
        false,
    )
    .await)
    .await;
    assert!(
        result["error"]
            .as_str()
            .unwrap()
            .contains("absolute deadline")
    );
    assert_eq!(result["diagnostics"]["issues"], diagnostics["issues"]);
    assert_eq!(result["diagnostics"]["phase"], "implementation");
    assert_eq!(result["diagnostics"]["tool"], "submit_draft");
    let events = val(req(&app, &read, "GET", None, Some(&alice), None, false).await).await;
    let events = events["items"].as_array().unwrap();
    assert_eq!(events.len(), 100);
    assert_eq!(events.last().unwrap()["code"], "timeout");
    assert_eq!(events.last().unwrap()["details"]["requests"], 3);
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
    assert_eq!(list["items"][0]["diagnostics"]["validations"], 2);
    assert_eq!(
        req(&app, &path, "POST", Some(body), None, Some(WORKER), false)
            .await
            .status(),
        StatusCode::CONFLICT
    );
}
#[tokio::test]
async fn opt_in_worker_leases_private_artifacts_revocation_and_quotas() {
    let app = app_with_config(
        "public",
        AppConfig {
            admin_token: Some(ADMIN.into()),
            generation: Some(GenerationConfig::new(WORKER.into()).unwrap()),
            ..AppConfig::new(Store::memory().unwrap())
        },
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
    let body = json!({"lease":job["lease"],"model":"test/no-paid-model","report":{"verification":"passed","review":"passed"},"artifact":{"definition":def(&job["simulationId"]),"moduleCode":engine}});
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
        StatusCode::OK // Idempotent completion receipt, not a second publication.
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
        app_with_config(
            "public",
            AppConfig {
                admin_token: Some(ADMIN.into()),
                generation: Some(GenerationConfig::new(WORKER.into()).unwrap()),
                ..AppConfig::new(Store::open(&db).unwrap())
            },
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
    // Simulate a healthy job already past the OLD six-minute deadline.
    connection.execute("UPDATE generation_jobs SET started_at=unixepoch()-400,lease_expires=unixepoch()+30,deadline_at=unixepoch()+120",[]).unwrap();
    let id = job["id"].as_i64().unwrap();
    let heartbeat = val(req(
        &app,
        &format!("/api/worker/generation/{id}/heartbeat"),
        "POST",
        Some(json!({"lease":job["lease"]})),
        None,
        Some(WORKER),
        false,
    )
    .await)
    .await;
    assert_eq!(heartbeat["active"], true);
    let remaining: i64 = connection
        .query_row(
            "SELECT lease_expires-unixepoch() FROM generation_jobs",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert!((85..=90).contains(&remaining));
    let event = json!({"lease":job["lease"],"event_key":"1:retry-safe-event","code":"model_request","details":{"phase":"build","requests":2}});
    for _ in 0..2 {
        assert_eq!(
            req(
                &app,
                &format!("/api/worker/generation/{id}/progress"),
                "POST",
                Some(event.clone()),
                None,
                Some(WORKER),
                false
            )
            .await
            .status(),
            StatusCode::OK
        );
    }
    assert_eq!(
        connection
            .query_row::<i64, _, _>("SELECT COUNT(*) FROM generation_events", [], |r| r.get(0))
            .unwrap(),
        1
    );
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
    assert_eq!(result["failureCode"], "worker_lost");
    assert_eq!(result["diagnostics"]["phase"], "build");
    assert_eq!(create(&app, &cookie).await.status(), StatusCode::ACCEPTED);
    let second = val(req(
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
    let connection = rusqlite::Connection::open(&db).unwrap();
    connection
        .execute(
            "UPDATE generation_jobs SET deadline_at=unixepoch()-1 WHERE id=?1",
            [second["id"].as_i64().unwrap()],
        )
        .unwrap();
    let expired = val(req(
        &app,
        &format!("/api/generation/jobs/{}", second["id"]),
        "GET",
        None,
        Some(&cookie),
        None,
        false,
    )
    .await)
    .await;
    assert_eq!(expired["failureCode"], "timeout");
    let renewed = val(req(
        &app,
        &format!("/api/worker/generation/{}/heartbeat", second["id"]),
        "POST",
        Some(json!({"lease":second["lease"]})),
        None,
        Some(WORKER),
        false,
    )
    .await)
    .await;
    assert_eq!(renewed["active"], false);
    drop(app);
    std::fs::remove_dir_all(dir).unwrap();
}
#[tokio::test]
async fn generation_defaults_off_and_tokens_are_separate() {
    let app = app_with_config(
        "public",
        AppConfig {
            admin_token: Some(ADMIN.into()),
            generation: None,
            ..AppConfig::new(Store::memory().unwrap())
        },
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
        app_with_config(
            "public",
            AppConfig {
                admin_token: Some(ADMIN.into()),
                generation: Some(GenerationConfig::new(ADMIN.into()).unwrap()),
                ..AppConfig::new(Store::memory().unwrap())
            },
        )
        .is_err()
    );
}

#[tokio::test]
async fn a_stopping_worker_returns_its_job_to_the_queue() {
    let app = app_with_config(
        "public",
        AppConfig {
            admin_token: Some(ADMIN.into()),
            generation: Some(GenerationConfig::new(WORKER.into()).unwrap()),
            ..AppConfig::new(Store::memory().unwrap())
        },
    )
    .unwrap();
    let alice = register(&app, "alice").await;
    assert_eq!(grant(&app, "alice", true).await.status(), StatusCode::OK);
    let id = val(create(&app, &alice).await).await["id"]
        .as_i64()
        .unwrap();
    let claim = || {
        req(
            &app,
            "/api/worker/generation/claim",
            "POST",
            None,
            None,
            Some(WORKER),
            false,
        )
    };
    let job = val(claim().await).await;
    assert_eq!(job["id"], id);
    let release_path = format!("/api/worker/generation/{id}/release");
    let release = |lease: &Value, bearer| {
        req(
            &app,
            &release_path,
            "POST",
            Some(json!({"lease": lease})),
            None,
            Some(bearer),
            false,
        )
    };
    assert_eq!(
        release(&job["lease"], ADMIN).await.status(),
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        release(&json!("not-the-lease"), WORKER).await.status(),
        StatusCode::CONFLICT
    );
    assert_eq!(
        release(&job["lease"], WORKER).await.status(),
        StatusCode::OK
    );
    let detail = val(req(
        &app,
        &format!("/api/generation/jobs/{id}"),
        "GET",
        None,
        Some(&alice),
        None,
        false,
    )
    .await)
    .await;
    assert_eq!(detail["status"], "queued");
    // The old lease is dead; the next claim gets the same job with a fresh lease.
    assert_eq!(
        release(&job["lease"], WORKER).await.status(),
        StatusCode::CONFLICT
    );
    let again = val(claim().await).await;
    assert_eq!(again["id"], id);
    assert_ne!(again["lease"], job["lease"]);
}

#[tokio::test]
async fn operator_limits_control_generation_quotas_and_prompt_size() {
    let app = app_with_config(
        "public",
        AppConfig {
            admin_token: Some(ADMIN.into()),
            generation: Some(GenerationConfig::new(WORKER.into()).unwrap()),
            ..AppConfig::new(Store::memory().unwrap())
        },
    )
    .unwrap();
    let alice = register(&app, "limits-alice").await;
    grant(&app, "limits-alice", true).await;
    let put = |limits: Value| {
        let app = app.clone();
        async move {
            req(
                &app,
                "/api/admin/limits",
                "PUT",
                Some(json!({ "limits": limits })),
                None,
                Some(ADMIN),
                false,
            )
            .await
        }
    };
    assert_eq!(
        req(
            &app,
            "/api/admin/limits",
            "GET",
            None,
            Some(&alice),
            None,
            false
        )
        .await
        .status(),
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        req(
            &app,
            "/api/admin/limits",
            "PUT",
            Some(json!({"limits":{"generationMaxPromptBytes":12}})),
            None,
            Some(ADMIN),
            false
        )
        .await
        .status(),
        StatusCode::UNPROCESSABLE_ENTITY
    );
    assert_eq!(
        put(json!({"generationPerDay":0,"generationMaxPromptBytes":256}))
            .await
            .status(),
        StatusCode::OK
    );
    let config = val(req(
        &app,
        "/api/generation/config",
        "GET",
        None,
        Some(&alice),
        None,
        false,
    )
    .await)
    .await;
    assert_eq!(config["perDay"], 0);
    assert_eq!(config["maxPromptBytes"], 256);
    assert_eq!(
        create(&app, &alice).await.status(),
        StatusCode::TOO_MANY_REQUESTS
    );
    assert_eq!(
        put(json!({"generationPerDay":1})).await.status(),
        StatusCode::OK
    );
    let long = json!({"prompt":"x".repeat(300),"acceptProviderProcessing":true});
    assert_eq!(
        req(
            &app,
            "/api/generation/jobs",
            "POST",
            Some(long),
            Some(&alice),
            None,
            true
        )
        .await
        .status(),
        StatusCode::UNPROCESSABLE_ENTITY
    );
    assert_eq!(create(&app, &alice).await.status(), StatusCode::ACCEPTED);
    assert_eq!(
        put(json!({"generationActiveGlobal":1})).await.status(),
        StatusCode::OK
    );
}

#[tokio::test]
async fn unverified_candidates_are_never_success_and_protocol_upgrade_is_explicit() {
    let app = app_with_config(
        "public",
        AppConfig {
            admin_token: Some(ADMIN.into()),
            generation: Some(GenerationConfig::new(WORKER.into()).unwrap()),
            ..AppConfig::new(Store::memory().unwrap())
        },
    )
    .unwrap();
    let alice = register(&app, "reliability-alice").await;
    grant(&app, "reliability-alice", true).await;
    let bob = register(&app, "reliability-bob").await;
    let id = val(create(&app, &alice).await).await["id"]
        .as_i64()
        .unwrap();
    assert_eq!(
        req(
            &app,
            "/api/worker/generation/claim",
            "POST",
            Some(json!({"protocolVersion":1})),
            None,
            Some(WORKER),
            false
        )
        .await
        .status(),
        StatusCode::CONFLICT
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
    let path = format!("/api/worker/generation/{id}/complete");
    let mut completion = json!({"lease":job["lease"],"model":"scripted/test","artifact":{"definition":def(&job["simulationId"]),"moduleCode":"export function mount(ui) {}"},"report":{"verification":"failed","review":"unavailable"}});
    assert_eq!(
        req(
            &app,
            &path,
            "POST",
            Some(completion.clone()),
            None,
            Some(WORKER),
            false
        )
        .await
        .status(),
        StatusCode::UNPROCESSABLE_ENTITY
    );
    completion["outcome"] = json!("needs_attention");
    completion["failure"] = json!("verification_failed");
    for _ in 0..2 {
        assert_eq!(
            req(
                &app,
                &path,
                "POST",
                Some(completion.clone()),
                None,
                Some(WORKER),
                false
            )
            .await
            .status(),
            StatusCode::OK
        );
    }
    completion["model"] = json!("different");
    assert_eq!(
        req(
            &app,
            &path,
            "POST",
            Some(completion),
            None,
            Some(WORKER),
            false
        )
        .await
        .status(),
        StatusCode::CONFLICT
    );
    let read = format!("/api/generation/jobs/{id}");
    let result = val(req(&app, &read, "GET", None, Some(&alice), None, false).await).await;
    assert_eq!(result["status"], "needs_attention");
    assert!(result["artifact"].is_object());
    assert_eq!(result["report"]["review"], "unavailable");
    assert_eq!(
        req(&app, &read, "GET", None, Some(&bob), None, false)
            .await
            .status(),
        StatusCode::NOT_FOUND
    );
}

#[tokio::test]
async fn checkpoint_storage_failure_is_terminal_and_actionable_not_heartbeat_expiry() {
    let app = app_with_config(
        "public",
        AppConfig {
            admin_token: Some(ADMIN.into()),
            generation: Some(GenerationConfig::new(WORKER.into()).unwrap()),
            ..AppConfig::new(Store::memory().unwrap())
        },
    )
    .unwrap();
    let alice = register(&app, "storage-alice").await;
    grant(&app, "storage-alice", true).await;
    let id = val(create(&app, &alice).await).await["id"]
        .as_i64()
        .unwrap();
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
    let completion = json!({"lease":job["lease"],"model":"scripted/no-inference","artifact":null,"outcome":"failed","failure":"storage_error","diagnostics":{"phase":"preflight","cause":"storage_error","requests":0},"report":{"verification":"unresolved","review":"unresolved"}});
    for _ in 0..2 {
        assert_eq!(
            req(
                &app,
                &format!("/api/worker/generation/{id}/complete"),
                "POST",
                Some(completion.clone()),
                None,
                Some(WORKER),
                false
            )
            .await
            .status(),
            StatusCode::OK
        );
    }
    let result = val(req(
        &app,
        &format!("/api/generation/jobs/{id}"),
        "GET",
        None,
        Some(&alice),
        None,
        false,
    )
    .await)
    .await;
    assert_eq!(result["status"], "failed");
    assert_eq!(result["failureCode"], "storage_error");
    assert!(result["error"].as_str().unwrap().contains("checkpoint"));
    assert_eq!(result["diagnostics"]["requests"], 0);
    let events = val(req(
        &app,
        &format!("/api/generation/jobs/{id}/events"),
        "GET",
        None,
        Some(&alice),
        None,
        false,
    )
    .await)
    .await;
    assert_eq!(
        events["items"].as_array().unwrap().last().unwrap()["code"],
        "storage_error"
    );
}
