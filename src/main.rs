use std::{
    env,
    error::Error,
    net::SocketAddr,
    path::{Path, PathBuf},
};

#[cfg(test)]
mod database_tests;

use tokio::net::TcpListener;
use tracing_subscriber::EnvFilter;

#[tokio::main]
async fn main() -> Result<(), Box<dyn Error>> {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "commonlab=info,tower_http=info".into()),
        )
        .init();

    let addr: SocketAddr = env::var("BIND_ADDR")
        .unwrap_or_else(|_| "127.0.0.1:8000".into())
        .parse()?;
    let public_dir = PathBuf::from(env::var("PUBLIC_DIR").unwrap_or_else(|_| "public".into()));
    // Fail early rather than silently serving 404s when deployed without assets.
    if !public_dir.join("index.html").is_file() {
        return Err(format!(
            "PUBLIC_DIR must contain index.html: {}",
            public_dir.display()
        )
        .into());
    }

    let database = private_database_path(
        &public_dir,
        PathBuf::from(
            env::var("DATABASE_PATH").unwrap_or_else(|_| "data/commonlab.sqlite3".into()),
        ),
    )?;
    let store = commonlab::Store::open(&database)?;
    let secure_cookies = env::var("COOKIE_SECURE")
        .ok()
        .map(|value| value.parse::<bool>())
        .transpose()?
        .unwrap_or(!addr.ip().is_loopback());
    let generation = env::var("GENERATION_WORKER_TOKEN")
        .ok()
        .map(commonlab::GenerationConfig::new)
        .transpose()?;
    let app = commonlab::app_with_generation(
        &public_dir,
        store,
        env::var("ADMIN_TOKEN").ok(),
        secure_cookies,
        generation,
    )?;
    let listener = TcpListener::bind(addr).await?;
    tracing::info!(address = %listener.local_addr()?, assets = %public_dir.display(), "CommonLab listening");
    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await?;
    Ok(())
}

// Never serve the database (including journals) as a static asset, even through symlinks.
fn private_database_path(public_dir: &Path, database: PathBuf) -> std::io::Result<PathBuf> {
    let parent = database
        .parent()
        .filter(|path| !path.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    std::fs::create_dir_all(parent)?;
    let path = match std::fs::symlink_metadata(&database) {
        Ok(_) => database.canonicalize()?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => parent.canonicalize()?.join(
            database
                .file_name()
                .ok_or_else(|| std::io::Error::other("DATABASE_PATH must name a file"))?,
        ),
        Err(error) => return Err(error),
    };
    if path.starts_with(public_dir.canonicalize()?) {
        return Err(std::io::Error::other(
            "DATABASE_PATH must be outside PUBLIC_DIR",
        ));
    }
    Ok(path)
}

async fn shutdown_signal() {
    let ctrl_c = async {
        tokio::signal::ctrl_c()
            .await
            .expect("failed to install Ctrl-C handler");
    };
    #[cfg(unix)]
    let terminate = async {
        tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            .expect("failed to install SIGTERM handler")
            .recv()
            .await;
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        _ = ctrl_c => {},
        _ = terminate => {},
    }
    tracing::info!("Shutting down");
}
