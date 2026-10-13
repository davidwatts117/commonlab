use super::private_database_path;
use std::{
    path::PathBuf,
    time::{SystemTime, UNIX_EPOCH},
};
struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "commonlab-private-db-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(path.join("public")).unwrap();
        Self(path)
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

#[test]
fn database_paths_cannot_be_inside_public_assets() {
    let fixture = Fixture::new();
    let public = fixture.0.join("public");
    let database =
        private_database_path(&public, fixture.0.join("data/submissions.sqlite3")).unwrap();
    assert!(!database.starts_with(public.canonicalize().unwrap()));
    assert!(private_database_path(&public, public.join("submissions.sqlite3")).is_err());
    assert!(
        private_database_path(
            &public,
            fixture.0.join("data/../public/submissions.sqlite3")
        )
        .is_err()
    );
    assert!(!public.join("submissions.sqlite3").exists());
}

#[cfg(unix)]
#[test]
fn database_paths_reject_symlink_and_dangling_symlink_escapes() {
    use std::os::unix::fs::symlink;
    let fixture = Fixture::new();
    let public = fixture.0.join("public");
    symlink(&public, fixture.0.join("alias")).unwrap();
    assert!(private_database_path(&public, fixture.0.join("alias/submissions.sqlite3")).is_err());
    std::fs::write(public.join("existing.sqlite3"), "").unwrap();
    symlink(
        public.join("existing.sqlite3"),
        fixture.0.join("existing-alias.sqlite3"),
    )
    .unwrap();
    assert!(private_database_path(&public, fixture.0.join("existing-alias.sqlite3")).is_err());
    symlink(
        public.join("missing.sqlite3"),
        fixture.0.join("dangling.sqlite3"),
    )
    .unwrap();
    assert!(private_database_path(&public, fixture.0.join("dangling.sqlite3")).is_err());
    assert!(!public.join("missing.sqlite3").exists());
}
