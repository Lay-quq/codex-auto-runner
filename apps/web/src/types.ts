export interface QuotaBucket {
  limitId: string;
  limitName: string | null;
  primary: { usedPercent: number | null; windowDurationMins: number | null; resetsAt: number | null } | null;
  secondary: { usedPercent: number | null; windowDurationMins: number | null; resetsAt: number | null } | null;
  credits: { hasCredits: boolean; unlimited: boolean } | null;
  planType: string | null;
  rateLimitReachedType: string | null;
}
export interface QuotaSnapshot {
  mode: string;
  status: "available" | "near_limit" | "exhausted" | "auth_required" | "unknown";
  buckets: QuotaBucket[];
  blockingBuckets: QuotaBucket[];
  usedPercent: number | null;
  nextEligibleAt: number | null;
  nextCheckAt: number;
  capturedAt: number;
  resetCreditsAvailable: number | null;
}
export interface TaskSummary {
  id: string; title: string; status: string; priority: number;
  threadId: string | null; projectPath: string; mode: string;
  runCycleCount: number; maxRunCycles: number;
  quotaCycleCount: number; maxQuotaCycles: number;
  retryCount: number; maxRetryCount: number;
  nextRunAt: number | null; quotaResetAt: number | null;
  lastError: string | null; stagnantCycleCount: number;
  createdAt: number; updatedAt: number; startedAt: number | null; finishedAt: number | null;
  terminal: boolean;
  acceptanceCriteria: string[];
  validationCommands: { id: string; command: string; required?: boolean }[];
  originalGoal: string;
  sandboxMode: string; networkAccess: boolean; approvalMode: string; workspaceMode: string;
  useResetCreditOnWeeklyLimit: boolean;
  resetCreditLastAttemptAt: number | null;
  resetCreditLastOutcome: string | null;
}
export interface StatusResp {
  quota: QuotaSnapshot | null;
  autoRun: boolean;
  tasks: TaskSummary[];
  taskCount: number;
  runningCount: number;
  readyCount: number;
}
export interface EventRow {
  id: number; task_id: string | null; run_id: string | null;
  method: string; payload_json: string; at: number;
}

export interface CodexGoal {
  threadId: string;
  objective: string;
  status: "active" | "paused" | "blocked" | "usageLimited" | "budgetLimited" | "complete";
  tokenBudget?: number | null;
  tokensUsed?: number;
  timeUsedSeconds?: number;
  updatedAt?: number;
}

export interface CodexSession {
  id: string;
  sessionId: string | null;
  name: string | null;
  preview: string;
  cwd: string | null;
  source: string | null;
  updatedAt: number | null;
  createdAt: number | null;
  status: string;
  loaded: boolean;
  goal: CodexGoal | null;
}
