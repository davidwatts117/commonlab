//! Operator-tunable quotas. Stored in SQLite so every server process sees the same values.
use rusqlite::{Connection, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

/// (JSON key, default, minimum, maximum). Rejecting zero-length windows and absurd values keeps
/// a typo from either disabling abuse protection or locking everyone out.
const FIELDS: [(&str, i64, i64, i64); 8] = [
    ("submissionsPerHour", 100, 1, 1_000_000),
    ("pendingSubmissions", 500, 1, 1_000_000),
    ("retainedSubmissions", 2_000, 1, 10_000_000),
    ("generationPerDay", 3, 0, 10_000),
    ("generationGlobalPerDay", 20, 0, 1_000_000),
    ("generationActiveGlobal", 10, 1, 10_000),
    ("generationRetainedJobs", 500, 1, 10_000_000),
    ("generationMaxPromptBytes", 8_000, 256, 64_000),
];

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Limits {
    pub submissions_per_hour: i64,
    pub pending_submissions: i64,
    pub retained_submissions: i64,
    pub generation_per_day: i64,
    pub generation_global_per_day: i64,
    pub generation_active_global: i64,
    pub generation_retained_jobs: i64,
    pub generation_max_prompt_bytes: i64,
}
impl Default for Limits {
    fn default() -> Self {
        let mut limits = Self {
            submissions_per_hour: 0,
            pending_submissions: 0,
            retained_submissions: 0,
            generation_per_day: 0,
            generation_global_per_day: 0,
            generation_active_global: 0,
            generation_retained_jobs: 0,
            generation_max_prompt_bytes: 0,
        };
        for (key, value, _, _) in FIELDS {
            limits.set(key, value);
        }
        limits
    }
}
impl Limits {
    fn set(&mut self, key: &str, value: i64) {
        match key {
            "submissionsPerHour" => self.submissions_per_hour = value,
            "pendingSubmissions" => self.pending_submissions = value,
            "retainedSubmissions" => self.retained_submissions = value,
            "generationPerDay" => self.generation_per_day = value,
            "generationGlobalPerDay" => self.generation_global_per_day = value,
            "generationActiveGlobal" => self.generation_active_global = value,
            "generationRetainedJobs" => self.generation_retained_jobs = value,
            "generationMaxPromptBytes" => self.generation_max_prompt_bytes = value,
            _ => {}
        }
    }
    /// Stored values override defaults; malformed or out-of-range rows are ignored rather than
    /// breaking every request that reads quotas.
    pub fn load(connection: &Connection) -> rusqlite::Result<Self> {
        let mut limits = Self::default();
        let mut statement = connection.prepare("SELECT key, value FROM settings")?;
        let rows = statement.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
        })?;
        for row in rows {
            let (key, value) = row?;
            if Self::allowed(&key, value) {
                limits.set(&key, value);
            }
        }
        Ok(limits)
    }
    fn allowed(key: &str, value: i64) -> bool {
        FIELDS
            .iter()
            .any(|(name, _, min, max)| *name == key && (value >= *min && value <= *max))
    }
    /// Only provided fields are updated; every supplied value must be an integer in range.
    pub fn save(&self, connection: &Connection, changes: &Value) -> Result<(), String> {
        let changes = changes
            .as_object()
            .ok_or_else(|| "Provide an object of limit values".to_owned())?;
        if changes.is_empty() {
            return Err("Provide at least one limit to change".into());
        }
        let mut checked = Vec::new();
        for (key, value) in changes {
            let Some((name, _, min, max)) = FIELDS.iter().find(|(name, ..)| name == key) else {
                return Err(format!("Unknown limit: {key}"));
            };
            let number = value
                .as_i64()
                .filter(|number| *number >= *min && *number <= *max)
                .ok_or_else(|| format!("{key} must be an integer from {min} to {max}"))?;
            checked.push((*name, number));
        }
        for (key, value) in checked {
            connection
                .execute(
                    "INSERT INTO settings(key, value, updated_at) VALUES (?1, ?2, unixepoch()) \
                     ON CONFLICT(key) DO UPDATE SET value = excluded.value, \
                     updated_at = excluded.updated_at",
                    params![key, value],
                )
                .map_err(|error| error.to_string())?;
        }
        Ok(())
    }
    pub fn json(&self) -> Value {
        json!({
            "submissionsPerHour": self.submissions_per_hour,
            "pendingSubmissions": self.pending_submissions,
            "retainedSubmissions": self.retained_submissions,
            "generationPerDay": self.generation_per_day,
            "generationGlobalPerDay": self.generation_global_per_day,
            "generationActiveGlobal": self.generation_active_global,
            "generationRetainedJobs": self.generation_retained_jobs,
            "generationMaxPromptBytes": self.generation_max_prompt_bytes,
        })
    }
    /// The defaults stay visible so the operator can see what a value reverted to.
    pub fn defaults_json() -> Value {
        let mut defaults = Value::Object(serde_json::Map::new());
        for (key, value, min, max) in FIELDS {
            defaults[key] = json!({"default": value, "min": min, "max": max});
        }
        defaults
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct Change {
    pub(crate) limits: Value,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_round_trip_and_reject_bad_values() {
        let mut connection = Connection::open_in_memory().unwrap();
        crate::migrations::migrate(&mut connection).unwrap();
        assert_eq!(Limits::load(&connection).unwrap(), Limits::default());
        let defaults = Limits::defaults_json();
        assert_eq!(defaults["generationPerDay"]["default"], 3);
        assert!(
            Limits::default()
                .save(&connection, &json!({"generationPerDay": 0}))
                .is_ok()
        );
        assert!(
            Limits::default()
                .save(&connection, &json!({"generationPerDay": -1}))
                .is_err()
        );
        assert!(
            Limits::default()
                .save(&connection, &json!({"pendingSubmissions": "500"}))
                .is_err()
        );
        assert!(
            Limits::default()
                .save(&connection, &json!({"unknown": 1}))
                .is_err()
        );
        assert!(Limits::default().save(&connection, &json!({})).is_err());
        assert_eq!(Limits::load(&connection).unwrap().generation_per_day, 0);
        // Out-of-range stored rows fall back to the default instead of breaking requests.
        connection
            .execute(
                "UPDATE settings SET value = -5 WHERE key = 'pendingSubmissions'",
                [],
            )
            .unwrap();
        assert_eq!(Limits::load(&connection).unwrap().pending_submissions, 500);
    }
}
