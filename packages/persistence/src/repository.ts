/**
 * SqliteRepository —— 基于 Node.js 内置 `node:sqlite`（实验性，Node 20+ 自带）。
 * 避免 better-sqlite3 的 native 构建依赖。提供：迁移、任务 CRUD、状态机写、
 * 项目锁、任务运行/事件、配额快照。
 */

import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { SCHEMA_SQL } from "./schema.js";
import type { ManagedTask, TaskStatus } from "./types.js";
import { canTransition, TERMINAL_STATUSES } from "./types.js";

export interface CreateTaskInput {
  title: string;
  projectPath: string;
  originalGoal: string;
  resumeInstruction?: string;
  acceptanceCriteria?: string[];
  priority?: number;
  threadId?: string | null;
  mode?: "new_thread" | "resume_thread" | "imported_thread";
  model?: string | null;
  sandboxMode?: "readOnly" | "workspaceWrite";
  networkAccess?: boolean;
  approvalMode?: "safe_autonomous" | "interactive";
  workspaceMode?: "direct" | "worktree";
  validationCommands?: { id: string; command: string; cwd?: string; timeoutMs?: number; required?: boolean; allowNetwork?: boolean }[];
  maxRunCycles?: number;
  maxQuotaCycles?: number;
  useResetCreditOnWeeklyLimit?: boolean;
  maxRetryCount?: number;
}

export function defaultDataDir(): string {
  const local = process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local");
  return join(local, "CodexAutoRunner", "data");
}

type Row = Record<string, unknown>;

export class SqliteRepository {
  readonly db: DatabaseSync;
  constructor(dbPath?: string) {
    const path = dbPath ?? join(defaultDataDir(), "runner.db");
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.db.exec("PRAGMA busy_timeout = 5000");
  }

  migrate(): void {
    this.db.exec(SCHEMA_SQL);
    this.ensureTaskColumn("use_reset_credit_on_weekly_limit", "INTEGER NOT NULL DEFAULT 0");
    this.ensureTaskColumn("reset_credit_last_attempt_at", "INTEGER");
    this.ensureTaskColumn("reset_credit_last_outcome", "TEXT");
    this.db.prepare("INSERT OR IGNORE INTO schema_version(version, applied_at) VALUES (?, ?)").run(1, Date.now());
  }

  /* ----------------------------- tasks ----------------------------- */

  createTask(input: CreateTaskInput): ManagedTask {
    const id = genId();
    const now = Date.now();
    const t: ManagedTask = {
      id,
      title: input.title,
      mode: input.mode ?? "new_thread",
      projectPath: input.projectPath,
      threadId: input.threadId ?? null,
      sessionId: null,
      originalGoal: input.originalGoal,
      resumeInstruction: input.resumeInstruction ?? "",
      acceptanceCriteria: input.acceptanceCriteria ?? [],
      priority: input.priority ?? 50,
      status: "READY",
      model: input.model ?? null,
      sandboxMode: input.sandboxMode ?? "workspaceWrite",
      networkAccess: input.networkAccess ?? false,
      approvalMode: input.approvalMode ?? "safe_autonomous",
      workspaceMode: input.workspaceMode ?? "direct",
      branchName: null,
      worktreePath: null,
      validationCommands: input.validationCommands ?? [],
      maxRunCycles: input.maxRunCycles ?? 5,
      runCycleCount: 0,
      maxQuotaCycles: input.maxQuotaCycles ?? 10,
      quotaCycleCount: 0,
      useResetCreditOnWeeklyLimit: input.useResetCreditOnWeeklyLimit ?? false,
      resetCreditLastAttemptAt: null,
      resetCreditLastOutcome: null,
      maxRetryCount: input.maxRetryCount ?? 3,
      retryCount: 0,
      nextRunAt: now,
      quotaResetAt: null,
      lastProgressHash: null,
      stagnantCycleCount: 0,
      createdAt: now,
      updatedAt: now,
      startedAt: null,
      finishedAt: null,
      lastError: null,
    };
    this.db.prepare(/* sql */ `
      INSERT INTO tasks (
        id,title,mode,project_path,thread_id,session_id,original_goal,resume_instruction,acceptance_criteria,
        priority,status,model,sandbox_mode,network_access,approval_mode,workspace_mode,
        validation_commands,max_run_cycles,run_cycle_count,max_quota_cycles,quota_cycle_count,
        use_reset_credit_on_weekly_limit,reset_credit_last_attempt_at,reset_credit_last_outcome,
        max_retry_count,retry_count,next_run_at,quota_reset_at,last_progress_hash,stagnant_cycle_count,
        created_at,updated_at,started_at,finished_at,last_error,branch_name,worktree_path
      ) VALUES (
        @id,@title,@mode,@project_path,@thread_id,@session_id,@original_goal,@resume_instruction,@acceptance_criteria,
        @priority,@status,@model,@sandbox_mode,@network_access,@approval_mode,@workspace_mode,
        @validation_commands,@max_run_cycles,@run_cycle_count,@max_quota_cycles,@quota_cycle_count,
        @use_reset_credit_on_weekly_limit,@reset_credit_last_attempt_at,@reset_credit_last_outcome,
        @max_retry_count,@retry_count,@next_run_at,@quota_reset_at,@last_progress_hash,@stagnant_cycle_count,
        @created_at,@updated_at,@started_at,@finished_at,@last_error,@branch_name,@worktree_path
      )
    `).run({
      id: t.id,
      title: t.title,
      mode: t.mode,
      project_path: t.projectPath,
      thread_id: t.threadId,
      session_id: t.sessionId,
      original_goal: t.originalGoal,
      resume_instruction: t.resumeInstruction,
      acceptance_criteria: JSON.stringify(t.acceptanceCriteria),
      priority: t.priority,
      status: t.status,
      model: t.model,
      sandbox_mode: t.sandboxMode,
      network_access: t.networkAccess ? 1 : 0,
      approval_mode: t.approvalMode,
      workspace_mode: t.workspaceMode,
      validation_commands: JSON.stringify(t.validationCommands),
      max_run_cycles: t.maxRunCycles,
      run_cycle_count: t.runCycleCount,
      max_quota_cycles: t.maxQuotaCycles,
      quota_cycle_count: t.quotaCycleCount,
      use_reset_credit_on_weekly_limit: t.useResetCreditOnWeeklyLimit ? 1 : 0,
      reset_credit_last_attempt_at: t.resetCreditLastAttemptAt,
      reset_credit_last_outcome: t.resetCreditLastOutcome,
      max_retry_count: t.maxRetryCount,
      retry_count: t.retryCount,
      next_run_at: t.nextRunAt,
      quota_reset_at: t.quotaResetAt,
      last_progress_hash: t.lastProgressHash,
      stagnant_cycle_count: t.stagnantCycleCount,
      created_at: t.createdAt,
      updated_at: t.updatedAt,
      started_at: t.startedAt,
      finished_at: t.finishedAt,
      last_error: t.lastError,
      branch_name: t.branchName,
      worktree_path: t.worktreePath,
    });
    return t;
  }

  getTask(id: string): ManagedTask | undefined {
    const row = this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as Row | undefined;
    return row ? rowToTask(row) : undefined;
  }

  listTasks(): ManagedTask[] {
    const rows = this.db.prepare("SELECT * FROM tasks ORDER BY priority DESC, created_at ASC").all() as Row[];
    return rows.map(rowToTask);
  }

  listResetCreditEligibleTasks(): ManagedTask[] {
    const rows = this.db
      .prepare(`SELECT * FROM tasks WHERE use_reset_credit_on_weekly_limit = 1 AND status IN ('WAITING_QUOTA','READY','NEEDS_CONTINUE') ORDER BY priority DESC, updated_at ASC`)
      .all() as Row[];
    return rows.map(rowToTask);
  }

  hasRunningTask(): boolean {
    const row = this.db
      .prepare(`SELECT 1 AS hit FROM tasks WHERE status IN ('PREPARING','STARTING_THREAD','RUNNING','VERIFYING','CANCELLING','RECOVERING') LIMIT 1`)
      .get();
    return !!row;
  }

  /** 最高优先级可运行任务，事务内推进 READY -> PREPARING */
  claimNextRunnable(now = Date.now()): ManagedTask | undefined {
    if (this.hasRunningTask()) return undefined;
    const row = this.db
      .prepare(`SELECT * FROM tasks WHERE status = 'READY' AND (next_run_at IS NULL OR next_run_at <= ?) ORDER BY priority DESC, next_run_at ASC NULLS LAST, created_at ASC LIMIT 1`)
      .get(now) as Row | undefined;
    if (!row) return undefined;
    const ok = this.transitionInTx(String(row.id), "READY", "PREPARING", now);
    return ok ? this.getTask(String(row.id)) : undefined;
  }

  transitionInTx(taskId: string, from: TaskStatus, to: TaskStatus, at = Date.now()): boolean {
    const cur = this.getTask(taskId);
    if (!cur) return false;
    if (cur.status !== from) {
      // 调用方期望的状态已变；按当前状态校验是否可去 to
      if (!canTransition(cur.status, to)) return false;
    } else if (!canTransition(from, to)) {
      return false;
    }
    try {
      this.db.exec("BEGIN");
      const r = this.db.prepare("UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?").run(to, at, taskId);
      if (r.changes !== 1) throw new Error("task update race");
      this.db.exec("COMMIT");
      return true;
    } catch {
      try { this.db.exec("ROLLBACK"); } catch { /* ignore */ }
      return false;
    }
  }

  forceStatus(taskId: string, to: TaskStatus, at = Date.now()): void {
    this.db.prepare("UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?").run(to, at, taskId);
  }

  /** 通用更新白名单字段（不涉及状态） */
  patch(taskId: string, fields: Partial<ManagedTask>, at = Date.now()): void {
    const allowed = [
      "threadId", "sessionId", "runCycleCount", "quotaCycleCount", "retryCount",
      "nextRunAt", "quotaResetAt", "lastProgressHash", "stagnantCycleCount", "startedAt", "finishedAt",
      "lastError", "branchName", "worktreePath", "resetCreditLastAttemptAt", "resetCreditLastOutcome",
    ] as const;
    const sets: string[] = [];
    const values: Record<string, string | number | null> = { task_id: taskId, updated_at: at };
    for (const k of allowed) {
      const v = (fields as Record<string, unknown>)[k];
      if (v === undefined) continue;
      const col = toSnake(k);
      sets.push(`${col} = @${col}`);
      // 转成 SQL 可接受的基础类型
      values[col] =
        v == null ? null :
        typeof v === "number" ? v :
        typeof v === "string" ? v :
        String(v);
    }
    if (!sets.length) return;
    sets.push(`updated_at = @updated_at`);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (this.db.prepare(`UPDATE tasks SET ${sets.join(", ")} WHERE id = @task_id`) as any).run(values);
  }

  deleteTask(taskId: string): void {
    this.db.prepare("DELETE FROM tasks WHERE id = ?").run(taskId);
  }

  /* ------------------------- project locks ------------------------- */

  acquireProjectLock(projectPath: string, taskId: string, runId: string | null): boolean {
    const now = Date.now();
    try {
      this.db.exec("BEGIN");
      const existing = this.db.prepare("SELECT task_id, released_at FROM project_locks WHERE project_path = ?").get(projectPath) as { task_id: string; released_at: number | null } | undefined;
      if (existing && existing.released_at == null) {
        if (existing.task_id !== taskId) {
          this.db.exec("ROLLBACK");
          return false;
        }
        this.db.prepare("UPDATE project_locks SET run_id = ?, acquired_at = ? WHERE project_path = ?").run(runId ?? "", now, projectPath);
        this.db.exec("COMMIT");
        return true;
      }
      this.db.prepare("INSERT OR REPLACE INTO project_locks(project_path, task_id, run_id, acquired_at, released_at) VALUES (?,?,?,?,NULL)").run(projectPath, taskId, runId ?? "", now);
      this.db.exec("COMMIT");
      return true;
    } catch {
      try { this.db.exec("ROLLBACK"); } catch { /* ignore */ }
      return false;
    }
  }

  releaseProjectLock(projectPath: string): void {
    this.db.prepare("UPDATE project_locks SET released_at = ? WHERE project_path = ?").run(Date.now(), projectPath);
  }

  isProjectLocked(projectPath: string): boolean {
    const r = this.db.prepare("SELECT released_at FROM project_locks WHERE project_path = ?").get(projectPath) as { released_at: number | null } | undefined;
    return !!r && r.released_at == null;
  }

  /* ------------------------------ runs ------------------------------ */

  insertRun(runId: string, taskId: string, turnId: string | null, status: string): void {
    this.db.prepare("INSERT INTO task_runs(id, task_id, turn_id, status, started_at) VALUES (?,?,?,?,?)").run(runId, taskId, turnId, status, Date.now());
  }

  finishRun(runId: string, status: string, resultJson: string | null, error: string | null, quotaExhausted = 0): void {
    this.db.prepare("UPDATE task_runs SET status = ?, finished_at = ?, result_json = ?, error = ?, quota_exhausted = ? WHERE id = ?").run(status, Date.now(), resultJson, error, quotaExhausted, runId);
  }

  /* ----------------------------- events ----------------------------- */

  appendEvent(taskId: string | null, method: string, payload: unknown, runId: string | null = null): void {
    this.db.prepare("INSERT INTO task_events(task_id, run_id, method, payload_json, at) VALUES (?,?,?,?,?)").run(taskId, runId, method, JSON.stringify(payload ?? null), Date.now());
  }

  listEvents(opts: { taskId?: string; limit?: number; since?: number } = {}): Array<{ id: number; task_id: string | null; run_id: string | null; method: string; payload_json: string; at: number }> {
    const limit = Math.min(opts.limit ?? 200, 1000);
    let rows: Row[];
    if (opts.taskId) {
      rows = stmtAllAny(this.db.prepare("SELECT * FROM task_events WHERE task_id = ? AND (? = 0 OR at >= ?) ORDER BY at DESC LIMIT ?"), opts.taskId, opts.since ?? 0, opts.since ?? 0, limit);
    } else {
      rows = stmtAllAny(this.db.prepare("SELECT * FROM task_events WHERE (? = 0 OR at >= ?) ORDER BY at DESC LIMIT ?"), opts.since ?? 0, opts.since ?? 0, limit);
    }
    return rows as unknown as Array<{ id: number; task_id: string | null; run_id: string | null; method: string; payload_json: string; at: number }>;
  }

  /* --------------------------- quota snaps --------------------------- */

  recordQuotaSnapshot(status: string, usedPercent: number | null, nextEligibleAt: number | null, payload: unknown): void {
    this.db.prepare("INSERT INTO quota_snapshots(status, used_percent, next_eligible_at, captured_at, payload_json) VALUES (?,?,?,?,?)").run(status, usedPercent, nextEligibleAt, Date.now(), JSON.stringify(payload));
  }

  listQuotaSnapshots(limit = 100): Array<{ id: number; status: string; used_percent: number | null; next_eligible_at: number | null; captured_at: number; payload_json: string }> {
    const rows = stmtAllAny(this.db.prepare("SELECT * FROM quota_snapshots ORDER BY captured_at DESC LIMIT ?"), limit);
    return rows as unknown as Array<{ id: number; status: string; used_percent: number | null; next_eligible_at: number | null; captured_at: number; payload_json: string }>;
  }

  listRuns(taskId: string): Array<{ id: string; task_id: string; turn_id: string | null; status: string; started_at: number; finished_at: number | null; result_json: string | null; error: string | null; quota_exhausted: number }> {
    const rows = stmtAllAny(this.db.prepare("SELECT * FROM task_runs WHERE task_id = ? ORDER BY started_at DESC LIMIT 100"), taskId);
    return rows as unknown as Array<{ id: string; task_id: string; turn_id: string | null; status: string; started_at: number; finished_at: number | null; result_json: string | null; error: string | null; quota_exhausted: number }>;
  }

  /* ------------------------- recovery scan ------------------------- */

  scanAbnormalRunning(): ManagedTask[] {
    const abnormal: string[] = ["PREPARING", "STARTING_THREAD", "RUNNING", "VERIFYING", "CANCELLING"];
    const ph = abnormal.map(() => "?").join(",");
    const stmt = this.db.prepare(`SELECT * FROM tasks WHERE status IN (${ph})`);
    // 用 any 避开 @types/node 22 对 Statement.run/all spread-arg 的严格签名约束
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rows = (stmt as unknown as { all(...p: unknown[]): Row[] }).all(...abnormal) as Row[];
    const tasks = rows.map(rowToTask);
    for (const t of tasks) this.forceStatus(t.id, "RECOVERING");
    return tasks;
  }

  close(): void {
    try { this.db.close(); } catch { /* ignore */ }
  }

  private ensureTaskColumn(name: string, definition: string): void {
    const rows = this.db.prepare("PRAGMA table_info(tasks)").all() as Array<{ name: string }>;
    if (rows.some((r) => r.name === name)) return;
    this.db.exec(`ALTER TABLE tasks ADD COLUMN ${name} ${definition}`);
  }
}

/* ------------------------ private helpers ------------------------ */

function rowToTask(r: Row): ManagedTask {
  return {
    id: String(r.id),
    title: String(r.title),
    mode: String(r.mode) as ManagedTask["mode"],
    projectPath: String(r.project_path),
    threadId: (r.thread_id as string | null) ?? null,
    sessionId: (r.session_id as string | null) ?? null,
    originalGoal: String(r.original_goal),
    resumeInstruction: String(r.resume_instruction),
    acceptanceCriteria: JSON.parse(String(r.acceptance_criteria)) as string[],
    priority: Number(r.priority),
    status: String(r.status) as TaskStatus,
    model: (r.model as string | null) ?? null,
    sandboxMode: String(r.sandbox_mode) as "readOnly" | "workspaceWrite",
    networkAccess: Number(r.network_access) === 1,
    approvalMode: String(r.approval_mode) as "safe_autonomous" | "interactive",
    workspaceMode: String(r.workspace_mode) as "direct" | "worktree",
    branchName: (r.branch_name as string | null) ?? null,
    worktreePath: (r.worktree_path as string | null) ?? null,
    validationCommands: JSON.parse(String(r.validation_commands)),
    maxRunCycles: Number(r.max_run_cycles),
    runCycleCount: Number(r.run_cycle_count),
    maxQuotaCycles: Number(r.max_quota_cycles),
    quotaCycleCount: Number(r.quota_cycle_count),
    useResetCreditOnWeeklyLimit: Number(r.use_reset_credit_on_weekly_limit ?? 0) === 1,
    resetCreditLastAttemptAt: (r.reset_credit_last_attempt_at as number | null) ?? null,
    resetCreditLastOutcome: (r.reset_credit_last_outcome as string | null) ?? null,
    maxRetryCount: Number(r.max_retry_count),
    retryCount: Number(r.retry_count),
    nextRunAt: (r.next_run_at as number | null) ?? null,
    quotaResetAt: (r.quota_reset_at as number | null) ?? null,
    lastProgressHash: (r.last_progress_hash as string | null) ?? null,
    stagnantCycleCount: Number(r.stagnant_cycle_count),
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
    startedAt: (r.started_at as number | null) ?? null,
    finishedAt: (r.finished_at as number | null) ?? null,
    lastError: (r.last_error as string | null) ?? null,
  };
}

function toSnake(s: string): string {
  return s.replace(/[A-Z]/g, (m) => "_" + m.toLowerCase());
}

// @types/node 22 对 StatementSync.all() 的 spread-arg 严格签名会报错，
// 用 any 旁路；运行时 node:sqlite 支持位置参数 spread。
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function stmtAllAny(stmt: any, ...args: unknown[]): Row[] {
  return stmt.all(...args) as Row[];
}

function genId(): string {
  return "task_" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

export { TERMINAL_STATUSES };
