use std::{
    path::Path,
    sync::{Arc, Mutex},
};

use kairo_core::{Agent, KairoError, Result};
use rusqlite::{Connection, params};

use crate::transcript::TRANSCRIPT_CAPACITY;

#[derive(Clone)]
pub struct Storage {
    connection: Arc<Mutex<Connection>>,
}

impl Storage {
    pub fn open(path: &Path) -> Result<Self> {
        let connection = Connection::open(path).map_err(storage_error)?;
        Self::from_connection(connection)
    }

    #[cfg(test)]
    pub fn in_memory() -> Result<Self> {
        Self::from_connection(Connection::open_in_memory().map_err(storage_error)?)
    }

    fn from_connection(connection: Connection) -> Result<Self> {
        connection
            .execute_batch(
                "
                PRAGMA journal_mode = WAL;
                PRAGMA foreign_keys = ON;
                CREATE TABLE IF NOT EXISTS agents (
                    id TEXT PRIMARY KEY,
                    name TEXT NOT NULL UNIQUE,
                    title TEXT,
                    title_locked INTEGER NOT NULL DEFAULT 1,
                    adapter TEXT NOT NULL,
                    command_json TEXT,
                    workspace TEXT NOT NULL,
                    status TEXT NOT NULL,
                    pid INTEGER,
                    created_at_ms INTEGER NOT NULL,
                    updated_at_ms INTEGER NOT NULL
                );
                CREATE TABLE IF NOT EXISTS terminal_events (
                    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
                    agent_id TEXT NOT NULL,
                    content BLOB NOT NULL,
                    FOREIGN KEY(agent_id) REFERENCES agents(id) ON DELETE CASCADE
                );
                CREATE INDEX IF NOT EXISTS terminal_events_agent_sequence
                    ON terminal_events(agent_id, sequence);
                ",
            )
            .map_err(storage_error)?;
        let has_title = connection
            .prepare("SELECT 1 FROM pragma_table_info('agents') WHERE name = 'title'")
            .map_err(storage_error)?
            .exists([])
            .map_err(storage_error)?;
        if !has_title {
            connection
                .execute("ALTER TABLE agents ADD COLUMN title TEXT", [])
                .map_err(storage_error)?;
        }
        connection
            .execute("UPDATE agents SET title = name WHERE title IS NULL OR title = ''", [])
            .map_err(storage_error)?;
        let has_title_locked = connection
            .prepare("SELECT 1 FROM pragma_table_info('agents') WHERE name = 'title_locked'")
            .map_err(storage_error)?
            .exists([])
            .map_err(storage_error)?;
        if !has_title_locked {
            connection
                .execute(
                    "ALTER TABLE agents ADD COLUMN title_locked INTEGER NOT NULL DEFAULT 1",
                    [],
                )
                .map_err(storage_error)?;
        }
        Ok(Self { connection: Arc::new(Mutex::new(connection)) })
    }

    pub fn load_agents(&self) -> Result<Vec<Agent>> {
        let connection = self.connection.lock().map_err(lock_error)?;
        let mut statement = connection
            .prepare(
                "SELECT id, name, title, title_locked, adapter, command_json, workspace, status, pid, created_at_ms, updated_at_ms
                 FROM agents ORDER BY created_at_ms, rowid",
            )
            .map_err(storage_error)?;
        let rows = statement
            .query_map([], |row| {
                let command_json: Option<String> = row.get(5)?;
                let command = command_json
                    .map(|value| serde_json::from_str(&value))
                    .transpose()
                    .map_err(|error| {
                        rusqlite::Error::FromSqlConversionFailure(
                            5,
                            rusqlite::types::Type::Text,
                            Box::new(error),
                        )
                    })?;
                let status: String = row.get(7)?;
                let status = serde_json::from_str(&format!("\"{status}\"")).map_err(|error| {
                    rusqlite::Error::FromSqlConversionFailure(
                        7,
                        rusqlite::types::Type::Text,
                        Box::new(error),
                    )
                })?;
                Ok(Agent {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    title: row.get(2)?,
                    title_locked: row.get(3)?,
                    adapter: row.get(4)?,
                    command,
                    workspace: row.get::<_, String>(6)?.into(),
                    status,
                    pid: row.get(8)?,
                    created_at_ms: row.get::<_, i64>(9)?.max(0) as u64,
                    updated_at_ms: row.get::<_, i64>(10)?.max(0) as u64,
                })
            })
            .map_err(storage_error)?;
        rows.collect::<std::result::Result<Vec<_>, _>>().map_err(storage_error)
    }

    pub fn save_agent(&self, agent: &Agent) -> Result<()> {
        let command =
            agent.command.as_ref().map(serde_json::to_string).transpose().map_err(storage_error)?;
        let status = serde_json::to_string(&agent.status).map_err(storage_error)?;
        let status = status.trim_matches('"');
        self.connection
            .lock()
            .map_err(lock_error)?
            .execute(
                "INSERT INTO agents (id, name, title, title_locked, adapter, command_json, workspace, status, pid, created_at_ms, updated_at_ms)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
                 ON CONFLICT(id) DO UPDATE SET
                    name = excluded.name, title = excluded.title, title_locked = excluded.title_locked, adapter = excluded.adapter, command_json = excluded.command_json,
                    workspace = excluded.workspace, status = excluded.status, pid = excluded.pid,
                    created_at_ms = excluded.created_at_ms, updated_at_ms = excluded.updated_at_ms",
                params![
                    agent.id,
                    agent.name,
                    agent.title,
                    agent.title_locked,
                    agent.adapter,
                    command,
                    agent.workspace.to_string_lossy(),
                    status,
                    agent.pid,
                    i64::try_from(agent.created_at_ms).unwrap_or(i64::MAX),
                    i64::try_from(agent.updated_at_ms).unwrap_or(i64::MAX),
                ],
            )
            .map_err(storage_error)?;
        Ok(())
    }

    pub fn delete_agent(&self, id: &str) -> Result<()> {
        self.connection
            .lock()
            .map_err(lock_error)?
            .execute("DELETE FROM agents WHERE id = ?1", params![id])
            .map_err(storage_error)?;
        Ok(())
    }

    pub fn append_event(&self, agent_id: &str, content: &[u8]) -> Result<()> {
        let connection = self.connection.lock().map_err(lock_error)?;
        connection
            .execute(
                "INSERT INTO terminal_events (agent_id, content) VALUES (?1, ?2)",
                params![agent_id, content],
            )
            .map_err(storage_error)?;
        self.trim_events(&connection, agent_id)
    }

    pub fn clear_events(&self, agent_id: &str) -> Result<()> {
        self.connection
            .lock()
            .map_err(lock_error)?
            .execute("DELETE FROM terminal_events WHERE agent_id = ?1", params![agent_id])
            .map_err(storage_error)?;
        Ok(())
    }

    pub fn events(&self, agent_id: &str) -> Result<Vec<u8>> {
        let connection = self.connection.lock().map_err(lock_error)?;
        let mut statement = connection
            .prepare("SELECT content FROM terminal_events WHERE agent_id = ?1 ORDER BY sequence")
            .map_err(storage_error)?;
        let rows = statement
            .query_map(params![agent_id], |row| row.get::<_, Vec<u8>>(0))
            .map_err(storage_error)?;
        let mut output = Vec::new();
        for row in rows {
            output.extend(row.map_err(storage_error)?);
        }
        Ok(output)
    }

    fn trim_events(&self, connection: &Connection, agent_id: &str) -> Result<()> {
        let total = connection
            .query_row(
                "SELECT COALESCE(SUM(length(content)), 0) FROM terminal_events WHERE agent_id = ?1",
                params![agent_id],
                |row| row.get::<_, i64>(0),
            )
            .map_err(storage_error)?
            .max(0) as usize;
        if total <= TRANSCRIPT_CAPACITY {
            return Ok(());
        }

        let mut retained = total;
        let mut statement = connection
            .prepare("SELECT sequence, length(content) FROM terminal_events WHERE agent_id = ?1 ORDER BY sequence")
            .map_err(storage_error)?;
        let events = statement
            .query_map(params![agent_id], |row| {
                Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?.max(0) as usize))
            })
            .map_err(storage_error)?;
        for event in events {
            let (sequence, length) = event.map_err(storage_error)?;
            if retained <= TRANSCRIPT_CAPACITY {
                break;
            }
            connection
                .execute("DELETE FROM terminal_events WHERE sequence = ?1", params![sequence])
                .map_err(storage_error)?;
            retained = retained.saturating_sub(length);
        }
        Ok(())
    }
}

fn lock_error<T>(_error: std::sync::PoisonError<T>) -> KairoError {
    KairoError::Runtime("storage lock is poisoned".to_owned())
}

fn storage_error(error: impl std::fmt::Display) -> KairoError {
    KairoError::Runtime(format!("storage error: {error}"))
}

#[cfg(test)]
mod tests {
    use super::{Connection, Storage};

    #[test]
    fn migration_assigns_existing_agents_a_title_from_their_name() {
        let connection = Connection::open_in_memory().expect("open test database");
        connection
            .execute_batch(
                "
                CREATE TABLE agents (
                    id TEXT PRIMARY KEY,
                    name TEXT NOT NULL UNIQUE,
                    adapter TEXT NOT NULL,
                    command_json TEXT,
                    workspace TEXT NOT NULL,
                    status TEXT NOT NULL,
                    pid INTEGER,
                    created_at_ms INTEGER NOT NULL,
                    updated_at_ms INTEGER NOT NULL
                );
                INSERT INTO agents VALUES (
                    'agent-1', 'old-terminal', 'shell', NULL, '/tmp', 'stopped', NULL, 1, 1
                );
                ",
            )
            .expect("create old database schema");

        let storage = Storage::from_connection(connection).expect("migrate old database");
        let agents = storage.load_agents().expect("load migrated agents");

        assert_eq!(agents[0].title, "old-terminal");
        assert!(agents[0].title_locked);
    }
}
