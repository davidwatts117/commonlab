mod auth;
mod contributions;
mod generation;
pub use generation::GenerationConfig;
mod migrations;
mod submissions;
mod validation;
pub use submissions::Store;

use std::{collections::HashSet, io, path::Path};

use axum::{Router, routing::get};
use tower_http::{
    services::{ServeDir, ServeFile},
    trace::TraceLayer,
};

fn invalid(message: impl Into<String>) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message.into())
}

/// Server settings beyond the asset directory. Start from [`AppConfig::new`] and override fields.
pub struct AppConfig {
    /// Private database for submissions, accounts and generation jobs.
    pub store: Store,
    /// Bearer token for maintainers; submissions stay disabled without one.
    pub admin_token: Option<String>,
    /// Secure, `__Host-` session cookies. Required for public HTTPS deployments.
    pub secure_cookies: bool,
    /// Opt-in AI generation queue; its worker token must differ from `admin_token`.
    pub generation: Option<GenerationConfig>,
}
impl AppConfig {
    pub fn new(store: Store) -> Self {
        Self {
            store,
            admin_token: None,
            secure_cookies: false,
            generation: None,
        }
    }
}

/// Route catalog entries into one fixed shell. Modules are code; page definitions are data.
/// UI/schema validation also runs in the browser and the Node catalog tests.
pub fn app(public_dir: impl AsRef<Path>) -> io::Result<Router> {
    app_with_config(public_dir, AppConfig::new(Store::memory()?))
}

pub fn app_with_config(public_dir: impl AsRef<Path>, config: AppConfig) -> io::Result<Router> {
    let AppConfig {
        store,
        admin_token,
        secure_cookies,
        generation,
    } = config;
    if generation
        .as_ref()
        .is_some_and(|config| !config.differs_from(admin_token.as_deref()))
    {
        return Err(invalid("Worker and administrator tokens must be different"));
    }
    let public_dir = public_dir.as_ref();
    let catalog_path = public_dir.join("simulations/catalog.json");
    let catalog: serde_json::Value = serde_json::from_slice(&std::fs::read(&catalog_path)?)
        .map_err(|error| invalid(format!("Invalid simulation catalog: {error}")))?;
    if catalog["schemaVersion"] != 1 {
        return Err(invalid("Unsupported simulation catalog schemaVersion"));
    }
    let simulations = catalog["simulations"]
        .as_array()
        .filter(|entries| !entries.is_empty())
        .ok_or_else(|| invalid("Catalog needs simulations"))?;
    let shell_path = public_dir.join("simulation.html");
    if !shell_path.is_file() {
        return Err(invalid("Missing shared simulation.html shell"));
    }
    let mut submission_state = submissions::SubmissionState::new(
        store,
        catalog.clone(),
        std::fs::read_to_string(&shell_path)?,
        admin_token,
        secure_cookies,
    )?;
    submission_state.generation = generation.map(std::sync::Arc::new);
    let mut router = Router::new().route("/healthz", get(|| async { "ok\n" }));
    let mut ids = HashSet::new();
    for simulation in simulations {
        let id = simulation["id"]
            .as_str()
            .ok_or_else(|| invalid("Simulation needs id"))?;
        let valid_slug = id.len() <= 80
            && id.as_bytes().first().is_some_and(u8::is_ascii_lowercase)
            && id.split('-').all(|part| {
                !part.is_empty()
                    && part
                        .bytes()
                        .all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit())
            });
        if !valid_slug || !ids.insert(id) {
            return Err(invalid(format!("Invalid or duplicate simulation id: {id}")));
        }
        let module_path = public_dir.join(format!("simulations/{id}.js"));
        if !module_path.is_file() {
            return Err(invalid(format!("Missing simulation module: {id}.js")));
        }
        router = router
            .route_service(&format!("/simulations/{id}"), ServeFile::new(&shell_path))
            .route_service(
                &format!("/simulations/{id}.html"),
                ServeFile::new(&shell_path),
            )
            .route_service(
                &format!("/simulations/{id}.js"),
                ServeFile::new(module_path),
            );
    }
    // The submission router owns the fallback and serves only published entries.
    Ok(router
        .merge(submissions::router(submission_state))
        .fallback_service(ServeDir::new(public_dir).append_index_html_on_directories(true))
        .layer(TraceLayer::new_for_http()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        body::{Body, to_bytes},
        http::{Method, Request, StatusCode, header},
    };
    use tower::ServiceExt;

    async fn request(method: Method, uri: &str) -> axum::response::Response {
        app(Path::new(env!("CARGO_MANIFEST_DIR")).join("public"))
            .unwrap()
            .oneshot(
                Request::builder()
                    .method(method)
                    .uri(uri)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap()
    }

    #[tokio::test]
    async fn serves_homepage_and_health() {
        let response = request(Method::GET, "/").await;
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.headers()[header::CONTENT_TYPE], "text/html");
        let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        assert!(String::from_utf8_lossy(&body).contains("CommonLab"));

        let response = request(Method::GET, "/healthz").await;
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            to_bytes(response.into_body(), usize::MAX).await.unwrap(),
            "ok\n"
        );
    }

    #[tokio::test]
    async fn serves_all_simulations_and_shared_assets() {
        for path in [
            "/index.html",
            "/index.js",
            "/main.css",
            "/library.js?v=5",
            "/guided.js?v=6",
            "/guided.css",
            "/cfu.js?v=1",
            "/cfu.css?v=1",
            "/commonlab-logo.png",
            "/simulations/pendulum.html",
            "/simulation.html?id=pendulum",
            "/simulation-page.mjs",
            "/simulation-schema.mjs",
            "/simulation-ui.mjs",
            "/simulations/catalog.json",
            "/simulations/pendulum.js",
            "/simulations/pendulum",
            "/simulations/gas-laws.html",
            "/simulations/circuits.html",
            "/simulations/projectile.html",
            "/simulations/states-of-matter.html",
            "/simulations/titration.html",
            "/simulations/build-a-nucleus.html",
        ] {
            assert_eq!(
                request(Method::GET, path).await.status(),
                StatusCode::OK,
                "{path}"
            );
        }
        let response = request(Method::GET, "/cfu.css").await;
        assert_eq!(response.headers()[header::CONTENT_TYPE], "text/css");
    }

    struct Fixture(std::path::PathBuf);

    impl Fixture {
        fn new() -> Self {
            let stamp = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let path =
                std::env::temp_dir().join(format!("commonlab-{}-{stamp}", std::process::id()));
            std::fs::create_dir_all(path.join("simulations")).unwrap();
            std::fs::write(path.join("simulation.html"), "<h1>Shared shell</h1>").unwrap();
            Self(path)
        }
        fn catalog(&self, value: serde_json::Value) {
            std::fs::write(self.0.join("simulations/catalog.json"), value.to_string()).unwrap();
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[tokio::test]
    async fn new_catalog_entries_get_routes_without_page_or_router_changes() {
        let fixture = Fixture::new();
        fixture
            .catalog(serde_json::json!({"schemaVersion": 1, "simulations": [{"id": "new-lab"}]}));
        std::fs::write(
            fixture.0.join("simulations/new-lab.js"),
            "export function mount() {}",
        )
        .unwrap();
        // Dropping an arbitrary page into this directory must not opt it into the app.
        std::fs::write(fixture.0.join("simulations/rogue.html"), "rogue page").unwrap();
        let router = app(&fixture.0).unwrap();
        for uri in ["/simulations/new-lab", "/simulations/new-lab.html"] {
            let response = router
                .clone()
                .oneshot(Request::builder().uri(uri).body(Body::empty()).unwrap())
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::OK);
            assert_eq!(
                to_bytes(response.into_body(), usize::MAX).await.unwrap(),
                "<h1>Shared shell</h1>"
            );
        }
        let response = router
            .oneshot(
                Request::builder()
                    .uri("/simulations/rogue.html")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
    }

    #[test]
    fn invalid_catalog_ids_versions_duplicates_and_missing_modules_fail_at_startup() {
        let fixture = Fixture::new();
        for id in ["../escape", "UPPERCASE", "bad--id", "bad-id-", ""] {
            fixture.catalog(serde_json::json!({"schemaVersion": 1, "simulations": [{"id": id}]}));
            assert!(
                app(&fixture.0)
                    .unwrap_err()
                    .to_string()
                    .contains("Invalid or duplicate")
            );
        }
        fixture
            .catalog(serde_json::json!({"schemaVersion": 2, "simulations": [{"id": "new-lab"}]}));
        assert!(
            app(&fixture.0)
                .unwrap_err()
                .to_string()
                .contains("schemaVersion")
        );
        fixture
            .catalog(serde_json::json!({"schemaVersion": 1, "simulations": [{"id": "new-lab"}]}));
        assert!(
            app(&fixture.0)
                .unwrap_err()
                .to_string()
                .contains("Missing simulation module")
        );
        std::fs::write(
            fixture.0.join("simulations/new-lab.js"),
            "export function mount() {}",
        )
        .unwrap();
        fixture.catalog(serde_json::json!({"schemaVersion": 1, "simulations": [{"id": "new-lab"}, {"id": "new-lab"}]}));
        assert!(
            app(&fixture.0)
                .unwrap_err()
                .to_string()
                .contains("Invalid or duplicate")
        );
    }

    #[tokio::test]
    async fn supports_head_without_a_body() {
        let response = request(Method::HEAD, "/simulations/pendulum.html").await;
        assert_eq!(response.status(), StatusCode::OK);
        assert!(
            to_bytes(response.into_body(), usize::MAX)
                .await
                .unwrap()
                .is_empty()
        );
    }

    #[tokio::test]
    async fn does_not_expose_source_or_fallback_to_homepage() {
        for path in [
            "/missing.html",
            "/Cargo.toml",
            "/src/main.rs",
            "/.git/config",
            "/tests/cfu.test.mjs",
            "/docs/guided-experiments-authoring.md",
            "/../Cargo.toml",
            "/%2e%2e/Cargo.toml",
            "/simulations/missing.html",
            "/simulations/missing",
            "/simulations/missing.js",
        ] {
            assert_eq!(
                request(Method::GET, path).await.status(),
                StatusCode::NOT_FOUND,
                "{path}"
            );
        }
        assert_eq!(
            request(Method::POST, "/index.html").await.status(),
            StatusCode::METHOD_NOT_ALLOWED
        );
    }
}
