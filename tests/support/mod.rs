use axum::{
    Router,
    body::Body,
    extract::Request,
    http::{Request as HttpRequest, StatusCode, header},
    middleware::{self, Next},
};
use serde_json::json;
use tower::ServiceExt;

// Legacy router tests still exercise the real authentication API, once per fixture.
pub async fn authenticated(router: Router) -> Router {
    static SETUP: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
    let _guard = SETUP.lock().await;
    let mut response = None;
    for action in ["register", "login"] {
        let result = router
            .clone()
            .oneshot(
                HttpRequest::builder()
                    .method("POST")
                    .uri(format!("/api/auth/{action}"))
                    .header("x-commonlab-request", "1")
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(
                        json!({"username":"fixture-owner","password":"test-only-password-12345"})
                            .to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        if result.status() == StatusCode::CONFLICT {
            continue;
        }
        assert!(
            result.status().is_success(),
            "authentication fixture: {}",
            result.status()
        );
        response = Some(result);
        break;
    }
    let response = response.unwrap();
    let cookie = response.headers()[header::SET_COOKIE]
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap()
        .to_owned();
    router.layer(middleware::from_fn(
        move |mut request: Request, next: Next| {
            let cookie = cookie.clone();
            async move {
                if request.uri().path() == "/api/submissions" && request.method() == "POST" {
                    request
                        .headers_mut()
                        .insert(header::COOKIE, cookie.parse().unwrap());
                    request
                        .headers_mut()
                        .insert("x-commonlab-request", "1".parse().unwrap());
                }
                next.run(request).await
            }
        },
    ))
}
