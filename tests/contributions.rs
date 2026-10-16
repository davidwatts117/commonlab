use axum::{
    Router,
    body::{Body, to_bytes},
    http::{Request, StatusCode},
    response::Response,
};
use commonlab::{AppConfig, Store, app_with_config};
use serde_json::{Value, json};
use tower::ServiceExt;
const TOKEN: &str = "test-only-administrator-token-00000000";
fn reviewed(store: Store) -> AppConfig {
    AppConfig {
        admin_token: Some(TOKEN.into()),
        ..AppConfig::new(store)
    }
}
async fn req(
    app: &Router,
    method: &str,
    path: &str,
    body: Option<Value>,
    cookie: Option<&str>,
    admin: bool,
    csrf: bool,
) -> Response {
    let mut builder = Request::builder().method(method).uri(path);
    if let Some(cookie) = cookie {
        builder = builder.header("Cookie", cookie);
    }
    if admin {
        builder = builder.header("Authorization", format!("Bearer {TOKEN}"));
    }
    if csrf {
        builder = builder.header("X-CommonLab-Request", "1");
    }
    let body = if let Some(body) = body {
        builder = builder.header("Content-Type", "application/json");
        Body::from(body.to_string())
    } else {
        Body::empty()
    };
    app.clone()
        .oneshot(builder.body(body).unwrap())
        .await
        .unwrap()
}
async fn value(response: Response) -> Value {
    serde_json::from_slice(&to_bytes(response.into_body(), usize::MAX).await.unwrap()).unwrap()
}
async fn register(app: &Router, name: &str) -> String {
    let response = req(
        app,
        "POST",
        "/api/auth/register",
        Some(json!({"username":name,"password":"a-long-test-password-123"})),
        None,
        false,
        true,
    )
    .await;
    assert_eq!(response.status(), StatusCode::CREATED);
    response.headers()["set-cookie"]
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap()
        .to_owned()
}
fn definition() -> Value {
    let catalog: Value =
        serde_json::from_str(include_str!("../public/simulations/catalog.json")).unwrap();
    let mut def = catalog["simulations"]
        .as_array()
        .unwrap()
        .iter()
        .find(|def| def["id"] == "pendulum")
        .unwrap()
        .clone();
    def["id"] = json!("versioned-lab");
    def["assessment"]["id"] = json!("revision-bank");
    def["lessons"] = json!([]);
    def
}
fn payload(def: &Value, revision: i64, code: &str) -> Value {
    json!({"definition":def,"revision":revision,"moduleCode":code})
}
async fn review(app: &Router, id: i64, revision: i64, decision: &str) -> Response {
    req(app,"POST",&format!("/api/admin/submissions/{id}/review"),Some(json!({"revision":revision,"decision":decision,"codeReviewed":true,"note":"Scientific review feedback <literal>"})),None,true,false).await
}
async fn module(app: &Router) -> String {
    String::from_utf8(
        to_bytes(
            req(
                app,
                "GET",
                "/simulations/versioned-lab.js",
                None,
                None,
                false,
                false,
            )
            .await
            .into_body(),
            usize::MAX,
        )
        .await
        .unwrap()
        .to_vec(),
    )
    .unwrap()
}
#[tokio::test]
async fn contributor_dashboard_paginates_only_owned_records() {
    let app = app_with_config("public", reviewed(Store::memory().unwrap())).unwrap();
    let alice = register(&app, "alice").await;
    let bob = register(&app, "bob").await;
    let mut def = definition();
    def.as_object_mut().unwrap().remove("assessment");
    for i in 0..21 {
        def["id"] = json!(format!("paged-lab-{i}"));
        assert_eq!(
            req(
                &app,
                "POST",
                "/api/submissions",
                Some(json!({"definition":def,"moduleCode":"private source must not be listed"})),
                Some(&alice),
                false,
                true
            )
            .await
            .status(),
            StatusCode::CREATED
        );
    }
    let first = value(
        req(
            &app,
            "GET",
            "/api/contributor/submissions?status=pending",
            None,
            Some(&alice),
            false,
            false,
        )
        .await,
    )
    .await;
    let items = first["items"].as_array().unwrap();
    assert_eq!(items.len(), 20);
    assert_eq!(first["hasMore"], true);
    let cursor = items.last().unwrap()["id"].as_i64().unwrap();
    let next = value(
        req(
            &app,
            "GET",
            &format!("/api/contributor/submissions?before={cursor}"),
            None,
            Some(&alice),
            false,
            false,
        )
        .await,
    )
    .await;
    assert_eq!(next["items"].as_array().unwrap().len(), 1);
    assert_eq!(next["hasMore"], false);
    let other = value(
        req(
            &app,
            "GET",
            "/api/contributor/submissions",
            None,
            Some(&bob),
            false,
            false,
        )
        .await,
    )
    .await;
    assert!(other["items"].as_array().unwrap().is_empty());
    assert_eq!(
        req(
            &app,
            "GET",
            "/api/contributor/submissions?before=0",
            None,
            Some(&alice),
            false,
            false
        )
        .await
        .status(),
        StatusCode::UNPROCESSABLE_ENTITY
    );
}
#[tokio::test]
async fn owner_revisions_are_private_stale_safe_and_do_not_modify_approved_snapshots() {
    let dir = std::env::temp_dir().join(format!(
        "commonlab-revisions-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    let db = dir.join("private.sqlite3");
    let make_app = || app_with_config("public", reviewed(Store::open(&db).unwrap())).unwrap();
    let mut app = make_app();
    let alice = register(&app, "alice").await;
    let bob = register(&app, "bob").await;
    let mut def = definition();
    let submitted = req(
        &app,
        "POST",
        "/api/submissions",
        Some(json!({"definition":def,"moduleCode":"original private source"})),
        Some(&alice),
        false,
        true,
    )
    .await;
    assert_eq!(submitted.status(), StatusCode::CREATED);
    let id = value(submitted).await["id"].as_i64().unwrap();
    let path = format!("/api/contributor/submissions/{id}");
    assert_eq!(
        req(&app, "GET", &path, None, None, false, false)
            .await
            .status(),
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        req(&app, "GET", &path, None, Some(&bob), false, false)
            .await
            .status(),
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        req(
            &app,
            "PUT",
            &path,
            Some(payload(&def, 1, "other account")),
            Some(&bob),
            false,
            true
        )
        .await
        .status(),
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        req(
            &app,
            "PUT",
            &path,
            Some(payload(&def, 1, "no CSRF")),
            Some(&alice),
            false,
            false
        )
        .await
        .status(),
        StatusCode::FORBIDDEN
    );
    def["title"] = json!("Reviewed revision two");
    let second = payload(&def, 1, "approved source two");
    assert_eq!(
        req(
            &app,
            "PUT",
            &path,
            Some(second.clone()),
            Some(&alice),
            false,
            true
        )
        .await
        .status(),
        StatusCode::OK
    );
    assert_eq!(
        req(&app, "PUT", &path, Some(second), Some(&alice), false, true)
            .await
            .status(),
        StatusCode::CONFLICT
    );
    assert_eq!(
        review(&app, id, 1, "publish").await.status(),
        StatusCode::CONFLICT
    );
    assert_eq!(
        review(&app, id, 2, "publish").await.status(),
        StatusCode::OK
    );
    assert_eq!(module(&app).await, "approved source two");
    def["title"] = json!("Not approved revision three");
    assert_eq!(
        req(
            &app,
            "PUT",
            &path,
            Some(payload(&def, 2, "unapproved source three")),
            Some(&alice),
            false,
            true
        )
        .await
        .status(),
        StatusCode::OK
    );
    app = make_app(); // Sessions, ownership, revision, and the separate publication survive restart.
    assert_eq!(module(&app).await, "approved source two");
    let catalog = value(
        req(
            &app,
            "GET",
            "/simulations/catalog.json",
            None,
            None,
            false,
            false,
        )
        .await,
    )
    .await;
    assert_eq!(
        catalog["simulations"]
            .as_array()
            .unwrap()
            .iter()
            .find(|def| def["id"] == "versioned-lab")
            .unwrap()["title"],
        "Reviewed revision two"
    );
    assert_eq!(review(&app, id, 3, "reject").await.status(), StatusCode::OK);
    assert_eq!(module(&app).await, "approved source two");
    let detail = value(req(&app, "GET", &path, None, Some(&alice), false, false).await).await;
    assert_eq!(detail["status"], "rejected");
    assert_eq!(detail["publishedRevision"], 2);
    assert!(detail["reviewNote"].as_str().unwrap().contains("<literal>"));
    def["assessment"]["questions"][0]["prompt"] = json!("A changed question");
    assert_eq!(
        req(
            &app,
            "PUT",
            &path,
            Some(payload(&def, 3, "source four")),
            Some(&alice),
            false,
            true
        )
        .await
        .status(),
        StatusCode::UNPROCESSABLE_ENTITY
    );
    def["assessment"]["version"] = json!(2);
    assert_eq!(
        req(
            &app,
            "PUT",
            &path,
            Some(payload(&def, 3, "source four")),
            Some(&alice),
            false,
            true
        )
        .await
        .status(),
        StatusCode::OK
    );
    let bank = def["assessment"].clone();
    def.as_object_mut().unwrap().remove("assessment");
    assert_eq!(
        req(
            &app,
            "PUT",
            &path,
            Some(payload(&def, 4, "source five")),
            Some(&alice),
            false,
            true
        )
        .await
        .status(),
        StatusCode::OK
    );
    let mut duplicate = definition();
    duplicate["id"] = json!("another-lab");
    assert_eq!(
        req(
            &app,
            "POST",
            "/api/submissions",
            Some(json!({"definition":duplicate,"moduleCode":"must not claim the removed bank"})),
            Some(&bob),
            false,
            true
        )
        .await
        .status(),
        StatusCode::CONFLICT
    );
    def["assessment"] = bank;
    def["assessment"]["questions"][0]["prompt"] = json!("Another changed question");
    assert_eq!(
        req(
            &app,
            "PUT",
            &path,
            Some(payload(&def, 5, "source six")),
            Some(&alice),
            false,
            true
        )
        .await
        .status(),
        StatusCode::UNPROCESSABLE_ENTITY
    );
    def["assessment"]["version"] = json!(3);
    assert_eq!(
        req(
            &app,
            "PUT",
            &path,
            Some(payload(&def, 5, "source six")),
            Some(&alice),
            false,
            true
        )
        .await
        .status(),
        StatusCode::OK
    );
    assert_eq!(
        review(&app, id, 6, "publish").await.status(),
        StatusCode::OK
    );
    assert_eq!(module(&app).await, "source six");
    assert_eq!(
        req(
            &app,
            "PUT",
            &path,
            Some(payload(&def, 6, "source seven")),
            Some(&alice),
            false,
            true
        )
        .await
        .status(),
        StatusCode::OK
    );
    let withdrawn = value(review(&app, id, 7, "withdraw").await).await;
    assert_eq!(withdrawn["status"], "pending");
    assert_eq!(withdrawn["hasPublication"], false);
    assert_eq!(
        req(
            &app,
            "GET",
            "/simulations/versioned-lab.js",
            None,
            None,
            false,
            false
        )
        .await
        .status(),
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        review(&app, id, 7, "publish").await.status(),
        StatusCode::OK
    );
    assert_eq!(module(&app).await, "source seven");
    let listed = req(
        &app,
        "GET",
        "/api/contributor/submissions?status=published",
        None,
        Some(&alice),
        false,
        false,
    )
    .await;
    assert_eq!(listed.headers()["cache-control"], "no-store");
    let listed = value(listed).await;
    assert_eq!(listed["items"].as_array().unwrap().len(), 1);
    assert_eq!(listed["items"][0]["publishedRevision"], 7);
    assert!(!listed.to_string().contains("source seven"));
    assert!(listed["items"][0].get("moduleCode").is_none());
    let history_path = format!("{path}/history");
    assert_eq!(
        req(&app, "GET", &history_path, None, Some(&bob), false, false)
            .await
            .status(),
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        req(&app, "GET", &history_path, None, None, false, false)
            .await
            .status(),
        StatusCode::UNAUTHORIZED
    );
    let history =
        value(req(&app, "GET", &history_path, None, Some(&alice), false, false).await).await;
    let events = history["events"].as_array().unwrap();
    assert_eq!(events.first().unwrap()["action"], "submitted");
    assert_eq!(events.last().unwrap()["action"], "publish");
    assert!(events.iter().any(|event| event["action"] == "reject"
        && event["note"].as_str().unwrap().contains("<literal>")));
    assert!(!history.to_string().contains("source seven"));
    let bob_list = value(
        req(
            &app,
            "GET",
            "/api/contributor/submissions",
            None,
            Some(&bob),
            false,
            false,
        )
        .await,
    )
    .await;
    assert!(bob_list["items"].as_array().unwrap().is_empty());
    assert_eq!(
        req(
            &app,
            "GET",
            "/api/contributor/submissions?status=unknown",
            None,
            Some(&alice),
            false,
            false
        )
        .await
        .status(),
        StatusCode::UNPROCESSABLE_ENTITY
    );
    def["id"] = json!("renamed-lab");
    assert_eq!(
        req(
            &app,
            "PUT",
            &path,
            Some(payload(&def, 7, "rename")),
            Some(&alice),
            false,
            true
        )
        .await
        .status(),
        StatusCode::UNPROCESSABLE_ENTITY
    );
    std::fs::remove_dir_all(dir).unwrap();
}

#[tokio::test]
async fn live_entries_stay_findable_and_operators_can_withdraw_offline() {
    let dir = std::env::temp_dir().join(format!(
        "commonlab-live-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    let db = dir.join("private.sqlite3");
    let app = app_with_config("public", reviewed(Store::open(&db).unwrap())).unwrap();
    let alice = register(&app, "alice").await;
    let mut def = definition();
    let submitted = req(
        &app,
        "POST",
        "/api/submissions",
        Some(json!({"definition":def,"moduleCode":"live source"})),
        Some(&alice),
        false,
        true,
    )
    .await;
    let id = value(submitted).await["id"].as_i64().unwrap();
    assert_eq!(
        review(&app, id, 1, "publish").await.status(),
        StatusCode::OK
    );
    def["title"] = json!("Revised lab");
    let path = format!("/api/contributor/submissions/{id}");
    let edited = req(
        &app,
        "PUT",
        &path,
        Some(payload(&def, 1, "revised source")),
        Some(&alice),
        false,
        true,
    )
    .await;
    assert_eq!(edited.status(), StatusCode::OK);
    let rejected = value(review(&app, id, 2, "reject").await).await;
    assert_eq!(rejected["status"], "rejected");
    assert_eq!(rejected["hasPublication"], true);
    let admin_list = |status: &'static str| {
        let app = app.clone();
        async move {
            let uri = format!("/api/admin/submissions?status={status}");
            value(req(&app, "GET", &uri, None, None, true, false).await).await["items"]
                .as_array()
                .unwrap()
                .clone()
        }
    };
    // The newest revision was rejected, but revision 1 is still public.
    assert!(admin_list("published").await.is_empty());
    let live = admin_list("live").await;
    assert_eq!(live.len(), 1);
    assert_eq!(live[0]["status"], "rejected");
    assert_eq!(live[0]["live"], true);
    assert_eq!(live[0]["publishedRevision"], 1);
    assert_eq!(admin_list("rejected").await[0]["live"], true);
    let mine = value(
        req(
            &app,
            "GET",
            "/api/contributor/submissions?status=live",
            None,
            Some(&alice),
            false,
            false,
        )
        .await,
    )
    .await;
    assert_eq!(mine["items"][0]["live"], true);
    assert_eq!(module(&app).await, "live source");

    // Operator recovery shares the maintainer's withdraw semantics without a running server.
    let store = Store::open(&db).unwrap();
    assert!(store.withdraw(id, "  ").is_err());
    assert!(store.withdraw(id + 100, "Missing").is_err());
    assert_eq!(
        store.withdraw(id, "Installed engine changed").unwrap(),
        "rejected"
    );
    assert!(store.withdraw(id, "Already withdrawn").is_err());
    assert!(admin_list("live").await.is_empty());
    assert_eq!(
        req(
            &app,
            "GET",
            "/simulations/versioned-lab.js",
            None,
            None,
            false,
            false
        )
        .await
        .status(),
        StatusCode::NOT_FOUND
    );
    let history_path = format!("{path}/history");
    let history =
        value(req(&app, "GET", &history_path, None, Some(&alice), false, false).await).await;
    let last = history["events"]
        .as_array()
        .unwrap()
        .last()
        .unwrap()
        .clone();
    assert_eq!(last["action"], "withdraw");
    assert_eq!(last["actor"], "operator");
    assert_eq!(last["note"], "Installed engine changed");
    std::fs::remove_dir_all(dir).unwrap();
}
