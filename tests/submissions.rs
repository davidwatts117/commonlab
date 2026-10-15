mod support;
use axum::{
    Router,
    body::{Body, to_bytes},
    http::{Method, Request, StatusCode, header},
    response::Response,
};
use commonlab::{Store, app_with_submissions};
use serde_json::{Value, json};
use std::{
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};
use tower::ServiceExt;

const TOKEN: &str = "test-only-administrator-token-00000000";
fn public() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("public")
}
async fn router() -> Router {
    support::authenticated(
        app_with_submissions(public(), Store::memory().unwrap(), Some(TOKEN.into())).unwrap(),
    )
    .await
}
fn definition(id: &str) -> Value {
    json!({"id":id,"title":"A new lab","subject":"physics","summary":"Explore a scientific relationship.","canvas":{"id":"labCanvas","label":"Lab scene","width":700,"height":480},"controls":[],"cards":[],"graphs":[],"lessons":[]})
}
fn installed(id: &str) -> Value {
    let catalog: Value =
        serde_json::from_str(include_str!("../public/simulations/catalog.json")).unwrap();
    let mut def = catalog["simulations"][0].clone();
    def["id"] = json!(id);
    def["assessment"]["id"] = json!(id);
    for lesson in def["lessons"].as_array_mut().unwrap() {
        lesson["sim"] = json!(id);
    }
    def
}
fn submission(id: &str) -> Value {
    json!({"definition":definition(id),"moduleCode":"// Never execute an unreviewed draft\nexport function mount(ui) {}","submittedBy":"<img src=x onerror=alert(1)>"})
}
async fn request(
    router: &Router,
    method: Method,
    uri: &str,
    value: Option<Value>,
    token: Option<&str>,
) -> Response {
    let mut builder = Request::builder().method(method).uri(uri);
    if let Some(token) = token {
        builder = builder.header(header::AUTHORIZATION, format!("Bearer {token}"));
    }
    let body = if let Some(value) = value {
        builder = builder.header(header::CONTENT_TYPE, "application/json");
        Body::from(value.to_string())
    } else {
        Body::empty()
    };
    router
        .clone()
        .oneshot(builder.body(body).unwrap())
        .await
        .unwrap()
}
async fn body(response: Response) -> Value {
    serde_json::from_slice(&to_bytes(response.into_body(), usize::MAX).await.unwrap()).unwrap()
}
async fn review(router: &Router, id: i64, decision: &str, code_reviewed: bool) -> Response {
    let item = body(
        request(
            router,
            Method::GET,
            &format!("/api/admin/submissions/{id}"),
            None,
            Some(TOKEN),
        )
        .await,
    )
    .await;
    request(router, Method::POST, &format!("/api/admin/submissions/{id}/review"), Some(json!({"decision":decision,"revision":item["revision"],"codeReviewed":code_reviewed,"note":"Reviewed by a trusted maintainer"})), Some(TOKEN)).await
}

#[tokio::test]
async fn private_drafts_require_auth_and_explicit_code_review_then_publish_and_withdraw() {
    let router = router().await;
    let submitted = submission("new-lab");
    let response = request(
        &router,
        Method::POST,
        "/api/submissions",
        Some(submitted.clone()),
        None,
    )
    .await;
    assert_eq!(response.status(), StatusCode::CREATED);
    let receipt = body(response).await;
    let id = receipt["id"].as_i64().unwrap();
    assert_eq!(receipt["status"], "pending");
    for uri in [
        "/simulations/new-lab",
        "/simulations/new-lab.html",
        "/simulations/new-lab.js",
        "/api/submissions/1",
    ] {
        assert_eq!(
            request(&router, Method::GET, uri, None, None)
                .await
                .status(),
            StatusCode::NOT_FOUND
        );
    }
    for uri in ["/api/admin/submissions", "/api/admin/submissions/1"] {
        assert_eq!(
            request(&router, Method::GET, uri, None, None)
                .await
                .status(),
            StatusCode::UNAUTHORIZED
        );
        assert_eq!(
            request(&router, Method::GET, uri, None, Some("incorrect-token"))
                .await
                .status(),
            StatusCode::UNAUTHORIZED
        );
    }
    let unauthorized = request(
        &router,
        Method::POST,
        "/api/admin/submissions/1/review",
        Some(json!({"decision":"publish","codeReviewed":true})),
        None,
    )
    .await;
    assert_eq!(unauthorized.status(), StatusCode::UNAUTHORIZED);
    let queue = body(
        request(
            &router,
            Method::GET,
            "/api/admin/submissions",
            None,
            Some(TOKEN),
        )
        .await,
    )
    .await;
    assert_eq!(queue["items"][0]["submittedBy"], submitted["submittedBy"]);
    assert!(queue["items"][0].get("moduleCode").is_none());
    let detail = request(
        &router,
        Method::GET,
        "/api/admin/submissions/1",
        None,
        Some(TOKEN),
    )
    .await;
    assert_eq!(detail.headers()[header::CACHE_CONTROL], "no-store");
    assert_eq!(body(detail).await["moduleCode"], submitted["moduleCode"]);
    let catalog = body(
        request(
            &router,
            Method::GET,
            "/simulations/catalog.json",
            None,
            None,
        )
        .await,
    )
    .await;
    assert_eq!(catalog["simulations"].as_array().unwrap().len(), 7);
    assert_eq!(
        review(&router, id, "publish", false).await.status(),
        StatusCode::UNPROCESSABLE_ENTITY
    );
    assert_eq!(
        review(&router, id, "publish", true).await.status(),
        StatusCode::OK
    );
    assert_eq!(
        review(&router, id, "publish", true).await.status(),
        StatusCode::CONFLICT
    );
    let response = request(&router, Method::GET, "/simulations/new-lab.js", None, None).await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        response.headers()[header::CONTENT_TYPE],
        "text/javascript; charset=utf-8"
    );
    assert_eq!(
        response.headers()[header::X_CONTENT_TYPE_OPTIONS],
        "nosniff"
    );
    assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
    assert_eq!(
        to_bytes(response.into_body(), usize::MAX).await.unwrap(),
        submitted["moduleCode"].as_str().unwrap()
    );
    let head = request(&router, Method::HEAD, "/simulations/new-lab.js", None, None).await;
    assert_eq!(head.status(), StatusCode::OK);
    assert!(
        to_bytes(head.into_body(), usize::MAX)
            .await
            .unwrap()
            .is_empty()
    );
    for uri in ["/simulations/new-lab", "/simulations/new-lab.html"] {
        assert_eq!(
            request(&router, Method::GET, uri, None, None)
                .await
                .status(),
            StatusCode::OK
        );
    }
    let catalog = body(
        request(
            &router,
            Method::GET,
            "/simulations/catalog.json",
            None,
            None,
        )
        .await,
    )
    .await;
    assert_eq!(catalog["simulations"].as_array().unwrap().len(), 8);
    assert!(catalog.to_string().find("submittedBy").is_none());
    let engines =
        body(request(&router, Method::GET, "/api/submissions/engines", None, None).await).await;
    assert_eq!(engines["ids"].as_array().unwrap().len(), 7);
    assert!(
        !engines["ids"]
            .as_array()
            .unwrap()
            .contains(&json!("new-lab"))
    );
    assert_eq!(
        review(&router, id, "withdraw", false).await.status(),
        StatusCode::OK
    );
    assert_eq!(
        request(&router, Method::GET, "/simulations/new-lab.js", None, None)
            .await
            .status(),
        StatusCode::NOT_FOUND
    );
    let catalog = body(
        request(
            &router,
            Method::GET,
            "/simulations/catalog.json",
            None,
            None,
        )
        .await,
    )
    .await;
    assert_eq!(catalog["simulations"].as_array().unwrap().len(), 7);
    assert_eq!(
        review(&router, id, "publish", true).await.status(),
        StatusCode::CONFLICT
    );
}

#[tokio::test]
async fn rejects_bad_definitions_sources_collisions_and_oversized_bodies() {
    let router = router().await;
    for invalid in [
        json!({"definition":definition("../bad"),"moduleCode":"export function mount(){}"}),
        json!({"definition":definition("safe-lab"),"engineId":"not-installed"}),
        json!({"definition":definition("safe-lab"),"engineId":"pendulum","moduleCode":"export function mount(){}"}),
        json!({"definition":definition("safe-lab"),"moduleCode":" "}),
        json!({"definition":definition("safe-lab"),"moduleCode":"x","status":"published"}),
        json!({"definition":definition("safe-lab"),"moduleCode":"x".repeat(128*1024+1)}),
    ] {
        assert_eq!(
            request(
                &router,
                Method::POST,
                "/api/submissions",
                Some(invalid),
                None
            )
            .await
            .status(),
            StatusCode::UNPROCESSABLE_ENTITY
        );
    }
    for (key, value) in [
        ("html", json!("<script>bad</script>")),
        ("module", json!("https://example.com/script.js")),
        (
            "canvas",
            json!({"id":"simulation-root","label":"Canvas","width":10,"height":10}),
        ),
    ] {
        let mut input = submission("unsafe-lab");
        input["definition"][key] = value;
        assert_eq!(
            request(&router, Method::POST, "/api/submissions", Some(input), None)
                .await
                .status(),
            StatusCode::UNPROCESSABLE_ENTITY
        );
    }
    let mut huge = submission("huge-lab");
    huge["definition"]["summary"] = json!("x".repeat(65 * 1024));
    assert_eq!(
        request(&router, Method::POST, "/api/submissions", Some(huge), None)
            .await
            .status(),
        StatusCode::PAYLOAD_TOO_LARGE
    );
    let response = router
        .clone()
        .oneshot(
            Request::builder()
                .method(Method::POST)
                .uri("/api/submissions")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from("x".repeat(257 * 1024)))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::PAYLOAD_TOO_LARGE);
    assert_eq!(
        request(
            &router,
            Method::POST,
            "/api/submissions",
            Some(submission("pendulum")),
            None
        )
        .await
        .status(),
        StatusCode::CONFLICT
    );
    let mut shared_bank = json!({"definition":installed("fresh-pendulum"),"engineId":"pendulum"});
    shared_bank["definition"]["assessment"]["id"] = json!("pendulum-period");
    assert_eq!(
        request(
            &router,
            Method::POST,
            "/api/submissions",
            Some(shared_bank),
            None
        )
        .await
        .status(),
        StatusCode::CONFLICT
    );
    let first = json!({"definition":installed("first-pendulum"),"engineId":"pendulum"});
    assert_eq!(
        request(
            &router,
            Method::POST,
            "/api/submissions",
            Some(first.clone()),
            None
        )
        .await
        .status(),
        StatusCode::CREATED
    );
    assert_eq!(
        request(&router, Method::POST, "/api/submissions", Some(first), None)
            .await
            .status(),
        StatusCode::CONFLICT
    );
    let mut duplicate_bank =
        json!({"definition":installed("second-pendulum"),"engineId":"pendulum"});
    duplicate_bank["definition"]["assessment"]["id"] = json!("first-pendulum");
    assert_eq!(
        request(
            &router,
            Method::POST,
            "/api/submissions",
            Some(duplicate_bank),
            None
        )
        .await
        .status(),
        StatusCode::CONFLICT
    );
    let mut broken_engine = installed("broken-pendulum");
    broken_engine["controls"] = json!([]);
    assert_eq!(
        request(
            &router,
            Method::POST,
            "/api/submissions",
            Some(json!({"definition":broken_engine,"engineId":"pendulum"})),
            None
        )
        .await
        .status(),
        StatusCode::UNPROCESSABLE_ENTITY
    );
}

struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "commonlab-submissions-{}-{}",
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
        self.0.join("submissions.sqlite3")
    }
    async fn router(&self) -> Router {
        support::authenticated(
            app_with_submissions(
                public(),
                Store::open(self.db()).unwrap(),
                Some(TOKEN.into()),
            )
            .unwrap(),
        )
        .await
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

#[tokio::test]
async fn sqlite_persists_published_reused_engine_and_rejected_private_draft() {
    let fixture = Fixture::new();
    {
        let router = fixture.router().await;
        let response = request(
            &router,
            Method::POST,
            "/api/submissions",
            Some(json!({"definition":installed("my-pendulum"),"engineId":"pendulum"})),
            None,
        )
        .await;
        assert_eq!(response.status(), StatusCode::CREATED);
        assert_eq!(
            review(&router, 1, "publish", false).await.status(),
            StatusCode::OK
        );
        assert_eq!(
            request(
                &router,
                Method::POST,
                "/api/submissions",
                Some(submission("rejected-lab")),
                None
            )
            .await
            .status(),
            StatusCode::CREATED
        );
        assert_eq!(
            review(&router, 2, "reject", false).await.status(),
            StatusCode::OK
        );
    }
    let router = fixture.router().await;
    let response = request(
        &router,
        Method::GET,
        "/simulations/my-pendulum.js",
        None,
        None,
    )
    .await;
    assert_eq!(
        to_bytes(response.into_body(), usize::MAX).await.unwrap(),
        "export { mount } from '/simulations/pendulum.js';\n"
    );
    assert_eq!(
        request(
            &router,
            Method::GET,
            "/simulations/rejected-lab.js",
            None,
            None
        )
        .await
        .status(),
        StatusCode::NOT_FOUND
    );
    let detail = body(
        request(
            &router,
            Method::GET,
            "/api/admin/submissions/2",
            None,
            Some(TOKEN),
        )
        .await,
    )
    .await;
    assert_eq!(detail["status"], "rejected");
    assert_eq!(detail["reviewNote"], "Reviewed by a trusted maintainer");
    assert_eq!(
        review(&router, 2, "publish", true).await.status(),
        StatusCode::CONFLICT
    );
    let missing_note = request(
        &router,
        Method::POST,
        "/api/admin/submissions/1/review",
        Some(json!({"decision":"withdraw"})),
        Some(TOKEN),
    )
    .await;
    assert_eq!(missing_note.status(), StatusCode::UNPROCESSABLE_ENTITY);
}

#[tokio::test]
async fn persistent_hourly_quota_and_private_queue_pagination() {
    let fixture = Fixture::new();
    {
        let router = fixture.router().await;
        for n in 0..100 {
            let response = request(
                &router,
                Method::POST,
                "/api/submissions",
                Some(submission(&format!("quota-{n}"))),
                None,
            )
            .await;
            assert_eq!(response.status(), StatusCode::CREATED);
        }
        let page = body(
            request(
                &router,
                Method::GET,
                "/api/admin/submissions",
                None,
                Some(TOKEN),
            )
            .await,
        )
        .await;
        assert_eq!(page["items"].as_array().unwrap().len(), 20);
        assert_eq!(page["hasMore"], true);
        let id = page["items"][19]["id"].as_i64().unwrap();
        let next = body(
            request(
                &router,
                Method::GET,
                &format!("/api/admin/submissions?before={id}"),
                None,
                Some(TOKEN),
            )
            .await,
        )
        .await;
        assert_eq!(next["items"][0]["id"], id - 1);
    }
    let router = fixture.router().await;
    assert_eq!(
        request(
            &router,
            Method::POST,
            "/api/submissions",
            Some(submission("quota-overflow")),
            None
        )
        .await
        .status(),
        StatusCode::TOO_MANY_REQUESTS
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            std::fs::metadata(fixture.db())
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
    }
}

#[tokio::test]
async fn review_configuration_is_fail_closed() {
    assert!(
        app_with_submissions(public(), Store::memory().unwrap(), Some("short".into())).is_err()
    );
    let router = app_with_submissions(public(), Store::memory().unwrap(), None).unwrap();
    assert_eq!(
        body(request(&router, Method::GET, "/api/submissions/config", None, None).await).await["enabled"],
        false
    );
    assert_eq!(
        request(
            &router,
            Method::POST,
            "/api/submissions",
            Some(submission("disabled-lab")),
            None
        )
        .await
        .status(),
        StatusCode::SERVICE_UNAVAILABLE
    );
    assert_eq!(
        request(
            &router,
            Method::GET,
            "/api/admin/submissions",
            None,
            Some(TOKEN)
        )
        .await
        .status(),
        StatusCode::SERVICE_UNAVAILABLE
    );
}
