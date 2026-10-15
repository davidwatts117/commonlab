//! Atomic, forward-only migrations of the private SQLite database.
use rusqlite::{Connection, TransactionBehavior};
pub fn migrate(connection: &mut Connection) -> std::io::Result<()> {
    connection
        .execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;")
        .map_err(std::io::Error::other)?;
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(std::io::Error::other)?;
    let version: u32 = transaction
        .pragma_query_value(None, "user_version", |row| row.get(0))
        .map_err(std::io::Error::other)?;
    if version > 2 {
        return Err(std::io::Error::other(
            "Unsupported submission database version",
        ));
    }
    if version == 0 {
        transaction.execute_batch("CREATE TABLE submissions (
            id INTEGER PRIMARY KEY, simulation_id TEXT NOT NULL UNIQUE, definition TEXT NOT NULL,
            engine_id TEXT, module_code TEXT, submitted_by TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','published','rejected','withdrawn')),
            created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
            reviewed_at TEXT, review_note TEXT NOT NULL DEFAULT '',
            CHECK ((engine_id IS NULL) != (module_code IS NULL)));
            CREATE UNIQUE INDEX submission_bank ON submissions(json_extract(definition,'$.assessment.id'));
            CREATE INDEX submission_status ON submissions(status,id);
            CREATE INDEX submission_created ON submissions(created_at);").map_err(std::io::Error::other)?;
    }
    if version < 2 {
        transaction.execute_batch("CREATE TABLE contributors (
            id INTEGER PRIMARY KEY, username TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL,
            created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')));
            CREATE TABLE contributor_sessions (
                token_hash TEXT PRIMARY KEY, contributor_id INTEGER NOT NULL REFERENCES contributors(id) ON DELETE CASCADE,
                created_at INTEGER NOT NULL DEFAULT (unixepoch()), expires_at INTEGER NOT NULL);
            CREATE INDEX sessions_owner ON contributor_sessions(contributor_id,created_at);
            CREATE INDEX sessions_expiry ON contributor_sessions(expires_at);
            CREATE TABLE auth_attempts (username TEXT NOT NULL, created_at INTEGER NOT NULL DEFAULT (unixepoch()));
            CREATE INDEX auth_attempt_time ON auth_attempts(created_at);
            CREATE INDEX auth_attempt_user ON auth_attempts(username,created_at);
            ALTER TABLE submissions ADD COLUMN contributor_id INTEGER REFERENCES contributors(id);
            CREATE INDEX submissions_owner ON submissions(contributor_id,id);
            PRAGMA user_version=2;").map_err(std::io::Error::other)?;
    }
    transaction.commit().map_err(std::io::Error::other)
}
