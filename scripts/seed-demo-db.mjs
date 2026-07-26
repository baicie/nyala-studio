#!/usr/bin/env node
// scripts/seed-demo-db.mjs — Phase 08 demo bootstrap script.
//
// Writes (or refreshes) the Nyala Studio demo SQLite database at
// `$NYALA_DATA_DIR/demo.db` (or `<data_dir>/nyala-studio/demo.db`).
// The script is idempotent and never touches the user's real data
// outside the resolved path.
//
// Use `pnpm run seed:demo` to populate the demo database without
// launching the full Tauri shell. The application itself calls
// `sql_bootstrap_demo` on first launch — this script exists for
// tooling, CI smoke checks, and documentation.
//
// Implementation notes:
//   * Uses `node:sqlite` (Node 22+, built-in). No third-party deps.
//   * Resolves the data directory the same way the Rust side does:
//     `NYALA_DATA_DIR` override, then `dirs`-style platform default.

import { mkdirSync, existsSync, statSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { resolveDemoDataDir } from './seed-demo-data-dir.mjs';

const TTL_MS = 30 * 24 * 60 * 60 * 1000;

function needsFresh(path) {
	if (!existsSync(path)) return true;
	const age = Date.now() - statSync(path).mtimeMs;
	return age > TTL_MS;
}

const root = resolveDemoDataDir();
const dbPath = join(root, 'demo.db');
const refresh = needsFresh(dbPath);

if (refresh) {
	if (existsSync(dbPath)) rmSync(dbPath);
}

mkdirSync(root, { recursive: true });
const db = new DatabaseSync(dbPath);
db.exec(`
    CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        email TEXT UNIQUE NOT NULL
    );
    CREATE TABLE IF NOT EXISTS orders (
        id INTEGER PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id),
        amount INTEGER NOT NULL,
        created_at TEXT NOT NULL
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
`);
db.close();

console.log(`demo db ${refresh ? 'created' : 'reused and seeded'} at ${dbPath}`);
