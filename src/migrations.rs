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
    if version > 4 {
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
    if version < 3 {
        transaction.execute_batch("ALTER TABLE submissions ADD COLUMN revision INTEGER NOT NULL DEFAULT 1;
            ALTER TABLE submissions ADD COLUMN updated_at TEXT;
            ALTER TABLE submissions ADD COLUMN published_definition TEXT;
            ALTER TABLE submissions ADD COLUMN published_engine_id TEXT;
            ALTER TABLE submissions ADD COLUMN published_module_code TEXT;
            ALTER TABLE submissions ADD COLUMN published_revision INTEGER;
            UPDATE submissions SET updated_at=created_at;
            UPDATE submissions SET published_definition=definition,published_engine_id=engine_id,published_module_code=module_code,published_revision=revision WHERE status='published';
            CREATE TABLE submission_banks(bank_id TEXT PRIMARY KEY,submission_id INTEGER NOT NULL REFERENCES submissions(id),bank_json TEXT NOT NULL);
            INSERT INTO submission_banks SELECT json_extract(definition,'$.assessment.id'),id,json_extract(definition,'$.assessment') FROM submissions WHERE json_extract(definition,'$.assessment.id') IS NOT NULL;
            CREATE TABLE submission_events(id INTEGER PRIMARY KEY,submission_id INTEGER NOT NULL REFERENCES submissions(id),revision INTEGER NOT NULL,action TEXT NOT NULL,status TEXT NOT NULL,actor TEXT NOT NULL,note TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')));
            CREATE INDEX events_submission ON submission_events(submission_id,id);
            CREATE INDEX events_time ON submission_events(created_at);
            INSERT INTO submission_events(submission_id,revision,action,status,actor,note,created_at) SELECT id,revision,'migrated',status,'system',review_note,COALESCE(reviewed_at,created_at) FROM submissions;
            PRAGMA user_version=3;").map_err(std::io::Error::other)?;
    }
    if version < 4 {
        transaction.execute_batch("ALTER TABLE contributors ADD COLUMN generation_allowed INTEGER NOT NULL DEFAULT 0 CHECK(generation_allowed IN (0,1));
            CREATE TABLE generation_jobs(id INTEGER PRIMARY KEY,contributor_id INTEGER NOT NULL REFERENCES contributors(id),prompt TEXT NOT NULL,simulation_id TEXT NOT NULL UNIQUE,status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','succeeded','failed','cancelled')),created_at INTEGER NOT NULL DEFAULT (unixepoch()),started_at INTEGER,finished_at INTEGER,lease_hash TEXT,lease_expires INTEGER,artifact TEXT,error TEXT NOT NULL DEFAULT '',model TEXT NOT NULL DEFAULT '');
            CREATE INDEX generation_owner ON generation_jobs(contributor_id,id);
            CREATE INDEX generation_status ON generation_jobs(status,id);
            CREATE INDEX generation_created ON generation_jobs(created_at);
            CREATE TABLE generation_access_events(id INTEGER PRIMARY KEY,contributor_id INTEGER NOT NULL REFERENCES contributors(id),allowed INTEGER NOT NULL,created_at INTEGER NOT NULL DEFAULT (unixepoch()));
            PRAGMA user_version=4;").map_err(std::io::Error::other)?;
    }
    transaction.commit().map_err(std::io::Error::other)
}
