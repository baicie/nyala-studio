/*---------------------------------------------------------------------------------------------
 * Nyala Studio - SQLite demo database seeder (Phase 08 packaging).
 *
 * `ensure_demo_db` writes a deterministic SQLite database containing a
 * tiny `users` / `orders` schema at the requested path. The function is
 * idempotent: re-running it never duplicates rows, never fails on an
 * existing file, and never touches user data outside the given file.
 *
 * This is intentionally a tiny, dependency-free module. No runtime
 * status checks, no secrets, no connection manager state. The Tauri
 * command (`sql_bootstrap_demo` in `product.rs`) wraps this with the
 * connection-profile wiring that the workbench needs.
 *
 * Test isolation uses `std::env::temp_dir()` paths unique to the
 * current `process::id()` so that parallel test runs do not collide.
 *--------------------------------------------------------------------------------------------*/

#![allow(clippy::needless_pass_by_value)]

use std::path::{Path, PathBuf};

use rusqlite::Connection;

use super::types::SqlCommandError;

/// Reserved connection id for the built-in Demo database.
pub const DEMO_PROFILE_ID: &str = "demo-sqlite";

/// Inline schema + seed data for the demo database.
///
/// `NOT EXISTS` keeps later runs idempotent without deleting or rewriting
/// rows that the user added to an existing demo database.
const DEMO_SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS users (
    id    INTEGER PRIMARY KEY,
    name  TEXT    NOT NULL,
    email TEXT    NOT NULL UNIQUE
);
CREATE TABLE IF NOT EXISTS orders (
    id         INTEGER PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id),
    amount     INTEGER NOT NULL,
    created_at TEXT    NOT NULL
);
INSERT OR IGNORE INTO users(id, name, email) VALUES
    (1, 'Alice', 'alice@example.com'),
    (2, 'Bob',   'bob@example.com'),
    (3, 'Carol', 'carol@example.com'),
    (4, 'Dave',  'dave@example.com'),
    (5, 'Eve',   'eve@example.com');
INSERT INTO orders(user_id, amount, created_at)
SELECT 1, 100, '2026-07-01'
WHERE NOT EXISTS (
    SELECT 1 FROM orders WHERE user_id = 1 AND amount = 100 AND created_at = '2026-07-01'
);
INSERT INTO orders(user_id, amount, created_at)
SELECT 1, 250, '2026-07-02'
WHERE NOT EXISTS (
    SELECT 1 FROM orders WHERE user_id = 1 AND amount = 250 AND created_at = '2026-07-02'
);
INSERT INTO orders(user_id, amount, created_at)
SELECT 2, 80, '2026-07-01'
WHERE NOT EXISTS (
    SELECT 1 FROM orders WHERE user_id = 2 AND amount = 80 AND created_at = '2026-07-01'
);
INSERT INTO orders(user_id, amount, created_at)
SELECT 3, 40, '2026-07-02'
WHERE NOT EXISTS (
    SELECT 1 FROM orders WHERE user_id = 3 AND amount = 40 AND created_at = '2026-07-02'
);
INSERT INTO orders(user_id, amount, created_at)
SELECT 3, 110, '2026-07-03'
WHERE NOT EXISTS (
    SELECT 1 FROM orders WHERE user_id = 3 AND amount = 110 AND created_at = '2026-07-03'
);
";

/// Returns the demo database directory.
///
/// Honors `NYALA_DATA_DIR` (used by tests and CI for isolation); falls
/// back to `<data_dir>/nyala-studio` where `data_dir` is the platform
/// default (`%APPDATA%` on Windows, `~/.local/share` on Linux,
/// `~/Library/Application Support` on macOS).
pub fn demo_data_dir() -> PathBuf {
    if let Some(custom) = std::env::var_os("NYALA_DATA_DIR") {
        return PathBuf::from(custom);
    }
    let base = dirs::data_dir().unwrap_or_else(|| PathBuf::from("."));
    base.join("nyala-studio")
}

/// Writes the demo schema + seed rows to `path`. Idempotent.
pub fn ensure_demo_db(path: &Path) -> Result<(), SqlCommandError> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| SqlCommandError::new("validation", format!("create_dir_all: {e}")))?;
    }
    let conn = Connection::open(path)
        .map_err(|e| SqlCommandError::new("open_failed", format!("open demo db: {e}")))?;
    conn.execute_batch(DEMO_SCHEMA)
        .map_err(|e| SqlCommandError::new("validation", format!("apply demo schema: {e}")))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_demo_path(test_name: &str) -> PathBuf {
        // Per-test isolation: pid alone collides across the three
        // demo_seed tests when they share the same process, and on
        // Windows `remove_file` can race against the SQLite handle
        // closing. Use a name suffix that includes the test name.
        let dir = std::env::temp_dir().join(format!(
            "nyala-demo-seed-{}-{}",
            std::process::id(),
            test_name
        ));
        std::fs::create_dir_all(&dir).expect("temp dir");
        dir.join("demo.db")
    }

    #[test]
    fn ensure_demo_db_creates_and_seeds() {
        let path = temp_demo_path("creates_and_seeds");
        let _ = std::fs::remove_file(&path);
        ensure_demo_db(&path).expect("seed");
        let conn = Connection::open(&path).expect("reopen");
        let n: i64 = conn
            .query_row("SELECT COUNT(*) FROM users", [], |r| r.get(0))
            .expect("count users");
        assert_eq!(n, 5);
        let m: i64 = conn
            .query_row("SELECT COUNT(*) FROM orders", [], |r| r.get(0))
            .expect("count orders");
        assert_eq!(m, 5);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn ensure_demo_db_is_idempotent() {
        let path = temp_demo_path("idempotent");
        let _ = std::fs::remove_file(&path);
        ensure_demo_db(&path).expect("first seed");
        ensure_demo_db(&path).expect("second seed must not fail");
        let conn = Connection::open(&path).expect("reopen");
        let n: i64 = conn
            .query_row("SELECT COUNT(*) FROM users", [], |r| r.get(0))
            .expect("count users");
        assert_eq!(n, 5, "idempotent seed must not duplicate users");
        let orders: i64 = conn
            .query_row("SELECT COUNT(*) FROM orders", [], |r| r.get(0))
            .expect("count orders");
        assert_eq!(orders, 5, "idempotent seed must not duplicate orders");
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn ensure_demo_db_preserves_user_rows_matching_seed_values() {
        let path = temp_demo_path("preserves_matching_user_rows");
        let _ = std::fs::remove_file(&path);
        ensure_demo_db(&path).expect("initial seed");

        {
            let conn = Connection::open(&path).expect("open for custom row setup");
            conn.execute_batch(
                "
                INSERT INTO orders(user_id, amount, created_at)
                VALUES (1, 100, '2026-07-01');
                INSERT INTO orders(user_id, amount, created_at)
                VALUES (5, 999, '2026-07-26');
                ",
            )
            .expect("insert matching and distinct custom rows");
        }

        ensure_demo_db(&path).expect("repeat seed");
        let conn = Connection::open(&path).expect("reopen database");
        let total: i64 = conn
            .query_row("SELECT COUNT(*) FROM orders", [], |r| r.get(0))
            .expect("count preserved orders");
        let matching_rows: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM orders
                 WHERE user_id = 1 AND amount = 100 AND created_at = '2026-07-01'",
                [],
                |r| r.get(0),
            )
            .expect("count matching custom rows");
        let custom_rows: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM orders
                 WHERE user_id = 5 AND amount = 999 AND created_at = '2026-07-26'",
                [],
                |r| r.get(0),
            )
            .expect("count custom rows");

        assert_eq!(total, 7);
        assert_eq!(
            matching_rows, 2,
            "bootstrap must not delete matching user data"
        );
        assert_eq!(custom_rows, 1, "bootstrap must preserve distinct user data");
        drop(conn);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn ensure_demo_db_orders_join_users() {
        let path = temp_demo_path("orders_join");
        let _ = std::fs::remove_file(&path);
        ensure_demo_db(&path).expect("seed");
        let conn = Connection::open(&path).expect("reopen");
        let joined: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM users u JOIN orders o ON o.user_id = u.id",
                [],
                |r| r.get(0),
            )
            .expect("join count");
        assert_eq!(joined, 5, "every order must reference a real user");
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn demo_data_dir_honors_nyala_data_dir_override() {
        // Save and restore env to avoid leaking test state across the suite.
        let prior = std::env::var_os("NYALA_DATA_DIR");
        std::env::set_var("NYALA_DATA_DIR", "/tmp/nyala-test-override");
        let dir = demo_data_dir();
        assert_eq!(dir, PathBuf::from("/tmp/nyala-test-override"));
        match prior {
            Some(value) => std::env::set_var("NYALA_DATA_DIR", value),
            None => std::env::remove_var("NYALA_DATA_DIR"),
        }
    }
}
