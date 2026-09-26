/**
 * SQLite connection + schema. The append-only `events` table is the source
 * of truth; `cards` is a materialized projection kept in sync in the same
 * transaction as each event append (see card-store.ts). `cards` is therefore
 * disposable — it can always be rebuilt by replaying `events` — which is why
 * no foreign key points from the truth (`events`) to the cache (`cards`).
 */

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";

export type Db = Database.Database;

export const DEFAULT_DB_PATH = "data/agent-kanban.db";

const SCHEMA = `
CREATE TABLE cards (
  id            TEXT PRIMARY KEY,
  title         TEXT NOT NULL,
  description   TEXT NOT NULL DEFAULT '',
  state         TEXT NOT NULL,
  executor      TEXT NOT NULL,
  review_policy TEXT NOT NULL,
  paused_from   TEXT,
  category      TEXT,
  focus         INTEGER NOT NULL DEFAULT 0,
  pending_tier  TEXT,
  scheduled_for TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE INDEX cards_state         ON cards(state);
CREATE INDEX cards_executor      ON cards(executor);
CREATE INDEX cards_category      ON cards(category);
CREATE INDEX cards_focus         ON cards(focus);
CREATE INDEX cards_scheduled_for ON cards(scheduled_for);

CREATE TABLE events (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  card_id       TEXT NOT NULL,
  type          TEXT NOT NULL,
  actor_id      TEXT NOT NULL,
  actor_type    TEXT NOT NULL,
  from_state    TEXT,
  to_state      TEXT,
  executor      TEXT NOT NULL,
  review_policy TEXT NOT NULL,
  note          TEXT,
  payload       TEXT,
  created_at    TEXT NOT NULL
);

CREATE INDEX events_card ON events(card_id, id);
`;

const MIGRATION_V2 = `
ALTER TABLE cards ADD COLUMN category TEXT;
ALTER TABLE cards ADD COLUMN focus INTEGER NOT NULL DEFAULT 0;
ALTER TABLE cards ADD COLUMN pending_tier TEXT;
CREATE INDEX cards_category ON cards(category);
CREATE INDEX cards_focus    ON cards(focus);
`;

// Rename states to the new working-memory model and add scheduled_for.
// State renames: backlog→inbox, ready→staging, in_progress→active,
//                manual_review→staging, done→log.
const MIGRATION_V3 = `
ALTER TABLE cards ADD COLUMN scheduled_for TEXT;
CREATE INDEX cards_scheduled_for ON cards(scheduled_for);

UPDATE cards SET state = 'inbox'   WHERE state = 'backlog';
UPDATE cards SET state = 'staging' WHERE state = 'ready';
UPDATE cards SET state = 'staging' WHERE state = 'manual_review';
UPDATE cards SET state = 'active'  WHERE state = 'in_progress';
UPDATE cards SET state = 'log'     WHERE state = 'done';

UPDATE cards SET paused_from = 'active'  WHERE paused_from = 'in_progress';
UPDATE cards SET paused_from = 'staging' WHERE paused_from = 'ready';

UPDATE events SET from_state = 'inbox'   WHERE from_state = 'backlog';
UPDATE events SET from_state = 'staging' WHERE from_state = 'ready';
UPDATE events SET from_state = 'staging' WHERE from_state = 'manual_review';
UPDATE events SET from_state = 'active'  WHERE from_state = 'in_progress';
UPDATE events SET from_state = 'log'     WHERE from_state = 'done';

UPDATE events SET to_state = 'inbox'   WHERE to_state = 'backlog';
UPDATE events SET to_state = 'staging' WHERE to_state = 'ready';
UPDATE events SET to_state = 'staging' WHERE to_state = 'manual_review';
UPDATE events SET to_state = 'active'  WHERE to_state = 'in_progress';
UPDATE events SET to_state = 'log'     WHERE to_state = 'done';
`;

/**
 * Open (creating if needed) and migrate a database. Pass ":memory:" for an
 * ephemeral database in tests.
 */
export function openDb(path: string = process.env.DATABASE_PATH ?? DEFAULT_DB_PATH): Db {
  if (path !== ":memory:") {
    mkdirSync(dirname(path), { recursive: true });
  }
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  migrate(db);
  return db;
}

function migrate(db: Db): void {
  const apply = db.transaction(() => {
    const version = db.pragma("user_version", { simple: true }) as number;
    if (version < 1) {
      db.exec(SCHEMA);
      db.pragma("user_version = 3");
      return;
    }
    if (version < 2) {
      db.exec(MIGRATION_V2);
    }
    if (version < 3) {
      db.exec(MIGRATION_V3);
      db.pragma("user_version = 3");
    }
  });
  apply();
}
