/**
 * SQLite schema（一次性迁移，幂等）。文档第 21 节子集 + 必要字段。
 */

export const SCHEMA_SQL = /* sql */ `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;

CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER PRIMARY KEY,
  applied_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
  id                  TEXT PRIMARY KEY,
  title               TEXT NOT NULL,
  mode                TEXT NOT NULL,                       -- new_thread | resume_thread | imported_thread
  project_path        TEXT NOT NULL,
  thread_id           TEXT,                                -- 已知线程 id（可空）
  session_id          TEXT,
  original_goal       TEXT NOT NULL,
  resume_instruction  TEXT NOT NULL DEFAULT '',
  acceptance_criteria TEXT NOT NULL DEFAULT '[]',          -- JSON array
  priority            INTEGER NOT NULL DEFAULT 50,
  status              TEXT NOT NULL DEFAULT 'DRAFT',
  model               TEXT,
  effort              TEXT,
  sandbox_mode        TEXT NOT NULL DEFAULT 'workspaceWrite',  -- readOnly | workspaceWrite
  network_access      INTEGER NOT NULL DEFAULT 0,
  approval_mode       TEXT NOT NULL DEFAULT 'safe_autonomous', -- safe_autonomous | interactive
  workspace_mode      TEXT NOT NULL DEFAULT 'direct',      -- direct | worktree
  branch_name         TEXT,
  worktree_path       TEXT,
  validation_commands TEXT NOT NULL DEFAULT '[]',         -- JSON array
  max_run_cycles      INTEGER NOT NULL DEFAULT 5,
  run_cycle_count     INTEGER NOT NULL DEFAULT 0,
  max_quota_cycles    INTEGER NOT NULL DEFAULT 10,
  quota_cycle_count   INTEGER NOT NULL DEFAULT 0,
  use_reset_credit_on_weekly_limit INTEGER NOT NULL DEFAULT 0,
  reset_credit_last_attempt_at INTEGER,
  reset_credit_last_outcome TEXT,
  max_retry_count     INTEGER NOT NULL DEFAULT 3,
  retry_count         INTEGER NOT NULL DEFAULT 0,
  next_run_at         INTEGER,
  quota_reset_at      INTEGER,
  last_progress_hash  TEXT,
  stagnant_cycle_count INTEGER NOT NULL DEFAULT 0,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL,
  started_at          INTEGER,
  finished_at         INTEGER,
  last_error          TEXT
);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_priority_run ON tasks(priority DESC, next_run_at ASC, created_at ASC);

-- 同一非终态任务的线程唯一绑定
CREATE UNIQUE INDEX IF NOT EXISTS uniq_task_thread_active
  ON tasks(thread_id) WHERE thread_id IS NOT NULL
    AND status NOT IN ('COMPLETED','FAILED_FINAL','CANCELLED');

CREATE TABLE IF NOT EXISTS task_runs (
  id           TEXT PRIMARY KEY,
  task_id      TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  turn_id      TEXT,
  status       TEXT NOT NULL,
  started_at   INTEGER NOT NULL,
  finished_at  INTEGER,
  result_json  TEXT,
  error        TEXT,
  quota_exhausted INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_runs_task ON task_runs(task_id);

CREATE TABLE IF NOT EXISTS task_events (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id      TEXT REFERENCES tasks(id) ON DELETE CASCADE,
  run_id       TEXT,
  method       TEXT NOT NULL,
  payload_json TEXT,
  at           INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_task ON task_events(task_id, at);
CREATE INDEX IF NOT EXISTS idx_events_method ON task_events(method, at);

CREATE TABLE IF NOT EXISTS quota_snapshots (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  status       TEXT NOT NULL,
  used_percent REAL,
  next_eligible_at INTEGER,
  captured_at  INTEGER NOT NULL,
  payload_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_quota_at ON quota_snapshots(captured_at DESC);

CREATE TABLE IF NOT EXISTS project_locks (
  project_path TEXT PRIMARY KEY,
  task_id      TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  run_id       TEXT,
  acquired_at  INTEGER NOT NULL,
  released_at  INTEGER
);

CREATE TABLE IF NOT EXISTS runtime_instance (
  id            TEXT PRIMARY KEY,
  pid           INTEGER NOT NULL,
  started_at    INTEGER NOT NULL,
  last_heartbeat INTEGER NOT NULL,
  active        INTEGER NOT NULL DEFAULT 1
);
`;
