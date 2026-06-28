/**
 * 任务领域模型（与文档第 11 节对应，缩简到 V1 实际所需字段）。
 * 由 persistence 序列化为 JSON 字符串存入 tasks 表。
 */

export type TaskMode = "new_thread" | "resume_thread" | "imported_thread";

export interface ValidationCommand {
  id: string;
  command: string;
  cwd?: string;
  timeoutMs?: number;
  required?: boolean;
  allowNetwork?: boolean;
}

export interface ManagedTask {
  id: string;
  title: string;
  mode: TaskMode;
  projectPath: string;
  threadId: string | null;
  sessionId: string | null;

  originalGoal: string;
  resumeInstruction: string;
  acceptanceCriteria: string[];

  priority: number;
  status: TaskStatus;

  model: string | null;
  sandboxMode: "readOnly" | "workspaceWrite";
  networkAccess: boolean;
  approvalMode: "safe_autonomous" | "interactive";

  workspaceMode: "direct" | "worktree";
  branchName: string | null;
  worktreePath: string | null;

  validationCommands: ValidationCommand[];

  maxRunCycles: number;
  runCycleCount: number;
  maxQuotaCycles: number;
  quotaCycleCount: number;
  useResetCreditOnWeeklyLimit: boolean;
  resetCreditLastAttemptAt: number | null;
  resetCreditLastOutcome: string | null;
  maxRetryCount: number;
  retryCount: number;

  nextRunAt: number | null;
  quotaResetAt: number | null;
  lastProgressHash: string | null;
  stagnantCycleCount: number;

  createdAt: number;
  updatedAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  lastError: string | null;
}

export type TaskStatus =
  | "DRAFT"
  | "READY"
  | "PREPARING"
  | "STARTING_THREAD"
  | "RUNNING"
  | "WAITING_QUOTA"
  | "WAITING_AUTH"
  | "WAITING_USER"
  | "WAITING_SCHEDULE"
  | "VERIFYING"
  | "NEEDS_CONTINUE"
  | "PAUSED"
  | "CANCELLING"
  | "COMPLETED"
  | "FAILED_RETRYABLE"
  | "FAILED_FINAL"
  | "CANCELLED"
  | "RECOVERING";

export const TERMINAL_STATUSES: ReadonlySet<TaskStatus> = new Set([
  "COMPLETED",
  "FAILED_FINAL",
  "CANCELLED",
]);

/** 合法状态转换（文档第 12.2 节）。非法返回 false；同值返回 true。 */
const TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  DRAFT: ["READY"],
  READY: ["PREPARING", "PAUSED"],
  PREPARING: ["STARTING_THREAD", "WAITING_USER", "FAILED_FINAL"],
  STARTING_THREAD: ["RUNNING", "WAITING_QUOTA", "WAITING_AUTH", "FAILED_RETRYABLE"],
  RUNNING: ["VERIFYING", "WAITING_QUOTA", "WAITING_USER", "FAILED_RETRYABLE", "FAILED_FINAL", "CANCELLING", "WAITING_AUTH"],
  VERIFYING: ["COMPLETED", "NEEDS_CONTINUE", "FAILED_RETRYABLE"],
  NEEDS_CONTINUE: ["READY"],
  WAITING_QUOTA: ["READY"],
  WAITING_AUTH: ["READY"],
  WAITING_USER: ["READY"],
  WAITING_SCHEDULE: ["READY"],
  FAILED_RETRYABLE: ["READY"],
  PAUSED: [], // 终止调度语义；可手工 READY
  CANCELLING: ["CANCELLED"],
  COMPLETED: [],
  FAILED_FINAL: [],
  CANCELLED: [],
  RECOVERING: ["READY", "VERIFYING", "WAITING_USER", "FAILED_FINAL"],
};

export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  if (from === to) return true;
  const allowed = TRANSITIONS[from];
  if (!allowed) return false;
  return allowed.includes(to);
}

/** PAUSED：允许任意非终态转过去（文档写“任意非终态 → PAUSED”），手动恢复 */
export function canPauseTransition(from: TaskStatus): boolean {
  return !TERMINAL_STATUSES.has(from) && from !== "RECOVERING" && from !== "PAUSED";
}

export function canCancelTransition(from: TaskStatus): boolean {
  return !TERMINAL_STATUSES.has(from);
}
