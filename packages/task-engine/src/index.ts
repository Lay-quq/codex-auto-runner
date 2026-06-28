/**
 * 任务/线程引擎。
 *
 * 职责：
 *  - thread/start（new_thread）或 thread/resume（resume/imported）
 *  - new_thread 的 turn/start 注入「原始目标 + 验收标准 + 恢复上下文」
 *  - resume/imported 线程只触发继续，让 Codex 读取原会话上下文
 *  - 监听 turn/started、turn/completed、turn/diff/updated、thread/status/changed 等通知
 *  - 解析结构化 CompletionResult（按 COMPLETION_SCHEMA）
 *  - 额度不足识别（失败 + 读取额度桶）→ WAITING_QUOTA + 保存检查点
 *  - 进展哈希 + 无进展检测
 *
 * 真实协议已探针验证（v0.142.3）：
 *   thread/start -> { thread:{ id, sessionId, status:{type} }, model, sandbox, ... }
 *   turn/start   -> { turn:{ id, status:"inProgress" } }
 *   turn/completed 通知 -> { threadId, turn:{ id, status:"completed"|"failed"|"interrupted", error? } }
 */

import { AppServerClient } from "@car/app-server-client";
import type { Logger } from "@car/logger";
import { SqliteRepository } from "@car/persistence";
import type { ManagedTask } from "@car/persistence";
import { progressHash, COMPLETION_SCHEMA, runValidations, validationsPassed, type CompletionResult, type ValidationResult } from "@car/validator";
import { inspect as inspectGit } from "@car/git-guard";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export type SandboxPolicyParam =
  | { type: "workspaceWrite"; networkAccess?: boolean; writableRoots?: string[] }
  | { type: "readOnly"; networkAccess?: boolean }
  | { type: "dangerFullAccess" };

export type ApprovalPolicyParam = "untrusted" | "on-failure" | "on-request" | "never";

export interface TaskEngineOptions {
  client: AppServerClient;
  repo: SqliteRepository;
  logger: Logger;
  /** 任务数据目录（检查点文件）。默认 %LOCALAPPDATA%\CodexAutoRunner\tasks */
  tasksDir?: string;
}

/** 单回合执行结果 */
export interface TurnOutcome {
  status: "completed" | "needs_continue" | "needs_user" | "blocked" | "failed" | "quota_exhausted" | "interrupted";
  result: CompletionResult | null;
  validations: ValidationResult[];
  raw: unknown;
  error: string | null;
}

export class TaskEngine {
  private readonly client: AppServerClient;
  private readonly repo: SqliteRepository;
  private readonly log: Logger;
  private readonly tasksDir: string;

  /** 当前等待中的回合：threadId -> resolve */
  private readonly pendingTurns = new Map<string, (o: TurnOutcome) => void>();

  constructor(opts: TaskEngineOptions) {
    this.client = opts.client;
    this.repo = opts.repo;
    this.log = opts.logger.child({ comp: "task-engine" });
    const local = process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local");
    this.tasksDir = opts.tasksDir ?? join(local, "CodexAutoRunner", "tasks");
    mkdirSync(this.tasksDir, { recursive: true });

    // 订阅通知
    this.client.on("notification", (method: string, params: unknown) => this.onNotification(method, params));
  }

  /* --------------------------- 公共入口 --------------------------- */

  /** 启动/恢复任务的一个回合：READY -> PREPARING(已由调度器推进) -> ... -> RUNNING -> VERIFYING */
  async runOneTurn(task: ManagedTask): Promise<TurnOutcome> {
    const log = this.log.child({ taskId: task.id, threadId: task.threadId ?? null });

    // 1. 准备线程
    let threadId = task.threadId;
    if (!threadId) {
      this.repo.transitionInTx(task.id, "PREPARING", "STARTING_THREAD");
      threadId = await this.startNewThread(task);
      this.repo.patch(task.id, { threadId, sessionId: threadId });
    } else {
      this.repo.transitionInTx(task.id, "PREPARING", "STARTING_THREAD");
      await this.resumeThread(task, threadId);
    }

    // 2. 启动回合
    this.repo.transitionInTx(task.id, "STARTING_THREAD", "RUNNING");
    const prompt = this.buildPrompt(task);
    const turnResp = await this.client.request<{ turn?: { id?: string } }>("turn/start", {
      threadId,
      input: [{ type: "text", text: prompt }],
      cwd: task.projectPath,
      sandboxPolicy: this.sandboxFor(task),
      approvalPolicy: this.approvalFor(task),
      outputSchema: COMPLETION_SCHEMA,
    });
    const turnId = turnResp.turn?.id;
    if (!turnId) throw new Error("turn/start returned no turn.id");
    const runId = "run_" + Math.random().toString(36).slice(2, 10);
    this.repo.insertRun(runId, task.id, turnId, "RUNNING");
    log.info("turn started", { turnId, runId });

    // 3. 等待 turn/completed
    const outcome = await this.awaitTurnCompletion(threadId, turnId);
    this.repo.appendEvent(task.id, "turn/completed", outcome, runId);

    // 4. 处理结果
    if (outcome.status === "quota_exhausted") {
      this.repo.transitionInTx(task.id, "RUNNING", "WAITING_QUOTA");
      this.repo.patch(task.id, {
        quotaCycleCount: task.quotaCycleCount + 1,
        quotaResetAt: null,
      });
      this.saveCheckpoint(task, outcome);
      return outcome;
    }
    if (outcome.status === "failed" || outcome.status === "interrupted") {
      this.repo.transitionInTx(task.id, "RUNNING", "FAILED_RETRYABLE");
      this.repo.patch(task.id, { lastError: outcome.error, retryCount: task.retryCount + 1 });
      return outcome;
    }

    // 5. 验证（completed / needs_continue / needs_user / blocked）
    this.repo.transitionInTx(task.id, "RUNNING", "VERIFYING");
    const validations = task.validationCommands.length
      ? await runValidations(task.validationCommands, { cwd: task.projectPath })
      : [];
    this.repo.appendEvent(task.id, "validation/results", validations, runId);
    const allOk = validationsPassed(validations, task.validationCommands);

    // 更新进展哈希
    const completed = outcome.result?.completed_items ?? [];
    const remaining = outcome.result?.remaining_items ?? [];
    const valSum = validations.map((v) => `${v.commandId}:${v.exitCode}`).join(",");
    const newHash = progressHash(this.diffHash(task.projectPath), completed, remaining, valSum);
    const stagnant = newHash === task.lastProgressHash;
    this.repo.patch(task.id, {
      lastProgressHash: newHash,
      stagnantCycleCount: stagnant ? task.stagnantCycleCount + 1 : 0,
      runCycleCount: task.runCycleCount + 1,
    });

    if (outcome.result?.status === "completed" && allOk && remaining.length === 0) {
      this.repo.transitionInTx(task.id, "VERIFYING", "COMPLETED");
      this.repo.patch(task.id, { finishedAt: Date.now() });
      this.saveCheckpoint(task, outcome);
      return outcome;
    }

    if (outcome.result?.status === "needs_continue" && task.runCycleCount + 1 < task.maxRunCycles && !stagnant) {
      this.repo.transitionInTx(task.id, "VERIFYING", "NEEDS_CONTINUE");
      this.repo.transitionInTx(task.id, "NEEDS_CONTINUE", "READY");
      this.repo.patch(task.id, { nextRunAt: Date.now() + 30_000 });
      return outcome;
    }

    // needs_user / blocked / 验证失败 / 无进展
    this.repo.transitionInTx(task.id, "VERIFYING", "WAITING_USER");
    this.repo.patch(task.id, { lastError: allOk ? null : "validation failed" });
    return outcome;
  }

  /* --------------------------- 线程操作 --------------------------- */

  private async startNewThread(task: ManagedTask): Promise<string> {
    const resp = await this.client.request<{ thread?: { id?: string } }>("thread/start", {
      cwd: task.projectPath,
      sandbox: task.sandboxMode === "readOnly" ? "read-only" : "workspace-write",
      approvalPolicy: this.approvalFor(task),
    });
    const id = resp.thread?.id;
    if (!id) throw new Error("thread/start returned no thread.id");
    this.repo.appendEvent(task.id, "thread/started", { threadId: id });
    return id;
  }

  private async resumeThread(task: ManagedTask, threadId: string): Promise<void> {
    // 检查线程是否在他处活跃
    const read = await this.client.request<{ thread?: { status?: { type?: string } } }>("thread/read", { threadId, includeTurns: false });
    const statusType = read.thread?.status?.type;
    if (statusType === "active" || statusType === "running") {
      throw new Error(`THREAD_ACTIVE_ELSEWHERE: thread ${threadId} status=${statusType}`);
    }
    await this.ensureGoalActive(threadId);
    await this.client.request("thread/resume", { threadId, approvalPolicy: this.approvalFor(task) });
    this.repo.appendEvent(task.id, "thread/resumed", { threadId });
  }

  private async ensureGoalActive(threadId: string): Promise<void> {
    const resp = await this.client.request<{ goal?: { objective?: string; status?: string; tokenBudget?: number | null } | null }>(
      "thread/goal/get",
      { threadId },
    ).catch((err) => {
      this.log.warn("goal read failed before resume", { threadId, err: String(err) });
      return null;
    });
    const goal = resp?.goal;
    if (!goal?.objective) return;
    const inactive = goal.status && ["paused", "blocked", "usageLimited", "budgetLimited", "complete"].includes(goal.status);
    if (!inactive) return;
    await this.client.request("thread/goal/set", {
      threadId,
      objective: goal.objective,
      status: "active",
      tokenBudget: goal.tokenBudget ?? null,
    }).catch((err) => {
      this.log.warn("goal activation failed before resume", { threadId, status: goal.status, err: String(err) });
    });
  }

  /* --------------------------- 通知处理 --------------------------- */

  private onNotification(method: string, params: unknown): void {
    if (method === "turn/completed") this.handleTurnCompleted(params);
    else if (method === "turn/started") this.repo.appendEvent(null, "turn/started", params);
    else if (method === "turn/diff/updated") this.repo.appendEvent(null, "turn/diff/updated", params);
    else if (method === "turn/plan/updated") this.repo.appendEvent(null, "turn/plan/updated", params);
    else if (method === "thread/status/changed") this.repo.appendEvent(null, "thread/status/changed", params);
    else if (method === "account/rateLimits/updated") this.repo.appendEvent(null, "account/rateLimits/updated", params);
  }

  private handleTurnCompleted(params: unknown): void {
    const p = params as { threadId?: string; turn?: { id?: string; status?: string; error?: { message?: string; codexErrorInfo?: unknown } } };
    const threadId = p.threadId;
    const turnId = p.turn?.id;
    if (!threadId) return;
    const resolver = this.pendingTurns.get(threadId);
    if (!resolver) return;

    const turnStatus = (p.turn?.status ?? "failed") as TurnOutcome["status"];
    const errMsg = p.turn?.error?.message ?? null;
    const errorInfo = p.turn?.error?.codexErrorInfo;

    // 额度相关错误？
    const isQuota = isQuotaError(errorInfo, errMsg);

    if (isQuota) {
      resolver({ status: "quota_exhausted", result: null, validations: [], raw: params, error: errMsg });
      this.pendingTurns.delete(threadId);
      return;
    }

    if (turnStatus === "completed") {
      const result = extractCompletionResult(p.turn);
      const status = (result?.status ?? "needs_continue") as TurnOutcome["status"];
      resolver({ status, result, validations: [], raw: params, error: errMsg });
      this.pendingTurns.delete(threadId);
      return;
    }

    if (turnStatus === "interrupted") {
      resolver({ status: "interrupted", result: null, validations: [], raw: params, error: errMsg });
      this.pendingTurns.delete(threadId);
      return;
    }

    // failed
    resolver({ status: "failed", result: null, validations: [], raw: params, error: errMsg });
    this.pendingTurns.delete(threadId);
  }

  private awaitTurnCompletion(threadId: string, turnId: string): Promise<TurnOutcome> {
    return new Promise<TurnOutcome>((resolve) => {
      let quotaPollBusy = false;
      const cleanup = () => {
        clearTimeout(timeout);
        clearInterval(quotaPoll);
        this.pendingTurns.delete(threadId);
      };
      const finish = (outcome: TurnOutcome) => {
        cleanup();
        resolve(outcome);
      };
      this.pendingTurns.set(threadId, finish);
      const quotaPoll = setInterval(() => {
        if (!this.pendingTurns.has(threadId) || quotaPollBusy) return;
        quotaPollBusy = true;
        this.client.request<{ goal?: { status?: string } | null }>("thread/goal/get", { threadId })
          .then((resp) => {
            const status = resp.goal?.status;
            if (status === "usageLimited" || status === "budgetLimited") {
              this.log.warn("goal became limited while waiting for turn", { threadId, turnId, status });
              this.client.request("turn/interrupt", { threadId, turnId }).catch(() => undefined);
              finish({ status: "quota_exhausted", result: null, validations: [], raw: resp, error: status });
            }
          })
          .catch((err) => this.log.debug("goal poll failed while waiting for turn", { threadId, turnId, err: String(err) }))
          .finally(() => { quotaPollBusy = false; });
      }, 30_000);
      if (typeof quotaPoll.unref === "function") quotaPoll.unref();
      // 兜底超时：避免通知丢失导致永远挂起（默认 15 分钟）
      const timeout = setTimeout(() => {
        if (this.pendingTurns.has(threadId)) {
          this.log.warn("turn await timeout, interrupting", { threadId, turnId });
          this.client.request("turn/interrupt", { threadId, turnId }).catch(() => undefined);
          finish({ status: "interrupted", result: null, validations: [], raw: null, error: "await timeout" });
        }
      }, 15 * 60_000);
      if (typeof timeout.unref === "function") timeout.unref();
    });
  }

  /* --------------------------- 工具 --------------------------- */

  private sandboxFor(task: ManagedTask): SandboxPolicyParam {
    if (task.sandboxMode === "readOnly") return { type: "readOnly", networkAccess: task.networkAccess };
    return { type: "workspaceWrite", networkAccess: task.networkAccess };
  }

  private approvalFor(task: ManagedTask): ApprovalPolicyParam {
    // safe_autonomous -> never（不等待无人值守审批）
    // interactive    -> on-request（需要时弹审批）
    return task.approvalMode === "safe_autonomous" ? "never" : "on-request";
  }

  private buildPrompt(task: ManagedTask): string {
    if (task.mode === "resume_thread" || task.mode === "imported_thread") {
      return "继续，并开启当前正在进行的目标任务";
    }

    const lines: string[] = [];
    lines.push("你正在执行一个由 Codex Auto Runner 管理的任务。");
    lines.push("");
    lines.push("原始目标：");
    lines.push(task.originalGoal);
    if (task.resumeInstruction) {
      lines.push("");
      lines.push("恢复指令：");
      lines.push(task.resumeInstruction);
    }
    if (task.acceptanceCriteria.length) {
      lines.push("");
      lines.push("验收标准：");
      task.acceptanceCriteria.forEach((c, i) => lines.push(`${i + 1}. ${c}`));
    }
    lines.push("");
    lines.push("要求：");
    lines.push("1. 不要自动 push、部署或发布。");
    lines.push("2. 不要修改 Git 历史（reset --hard、push --force、clean -fd 等）。");
    lines.push("3. 遇到需要高风险权限或歧义时停止并返回 needs_user。");
    lines.push("4. 完成后请严格按 outputSchema 返回 JSON 结果。");
    lines.push("5. remaining_items 为空且所有验证通过才算 completed。");
    return lines.join("\n");
  }

  private diffHash(cwd: string): string {
    const st = inspectGit(cwd);
    return createHash("sha256").update(st.porcelain.join("\n") + "|" + (st.head ?? "")).digest("hex");
  }

  private saveCheckpoint(task: ManagedTask, outcome: TurnOutcome): void {
    const dir = join(this.tasksDir, task.id);
    mkdirSync(dir, { recursive: true });
    const cp = {
      taskId: task.id,
      threadId: task.threadId,
      originalGoal: task.originalGoal,
      acceptanceCriteria: task.acceptanceCriteria,
      lastResult: outcome.result,
      lastError: outcome.error,
      savedAt: Date.now(),
    };
    writeFileSync(join(dir, "checkpoint.json"), JSON.stringify(cp, null, 2));
  }

  /** 重新评估回合：暂停期间检测到工作区变化时使用 */
  async reevaluate(task: ManagedTask): Promise<void> {
    if (!task.threadId) return;
    const before = task.lastProgressHash;
    const now = this.diffHash(task.projectPath);
    if (before && before !== now) {
      this.log.warn("workspace changed while paused; re-evaluation turn", { taskId: task.id });
    }
    // 不直接续跑，交回调度器；调度器会调用 runOneTurn
  }
}

/* ------------------------------ helpers ------------------------------ */

function isQuotaError(info: unknown, msg: string | null): boolean {
  if (info === "usageLimitExceeded") return true;
  if (typeof info === "string" && info.toLowerCase().includes("usage")) return true;
  if (msg && /rate.?limit|usage limit|quota|额度|使用限制/i.test(msg)) return true;
  return false;
}

/** 从 turn/completed 的 items 中抽取结构化 CompletionResult */
function extractCompletionResult(turn: unknown): CompletionResult | null {
  const t = turn as { items?: Array<{ type?: string; role?: string; content?: Array<{ type?: string; text?: string }> }> };
  const items = t?.items ?? [];
  // 找最后一条 assistant message 文本
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (!it) continue;
    const contents = it.content ?? [];
    for (let j = contents.length - 1; j >= 0; j--) {
      const c = contents[j];
      if (!c) continue;
      const text = c.text;
      if (typeof text !== "string") continue;
      // 尝试从文本里抽 JSON（模型可能包裹在 ```json ... ```）
      const parsed = tryParseJsonFromText(text);
      if (parsed && typeof parsed === "object" && "status" in parsed) {
        return parsed as CompletionResult;
      }
    }
  }
  return null;
}

function tryParseJsonFromText(text: string): unknown {
  // 直接
  try { return JSON.parse(text); } catch { /* continue */ }
  // ```json ... ```
  const m1 = text.match(/```json\s*([\s\S]*?)```/i);
  if (m1 && m1[1]) {
    try { return JSON.parse(m1[1].trim()); } catch { /* continue */ }
  }
  // 第一个 { ... 最后一个 }
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try { return JSON.parse(text.slice(start, end + 1)); } catch { /* continue */ }
  }
  return null;
}
