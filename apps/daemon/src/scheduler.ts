/**
 * Scheduler —— 调度器。额度恢复后/启动时/手动触发时：
 *   autoRunEnabled && 无 RUNNING 任务 && 额度可用
 *     → claimNextRunnable → projectGuard → TaskEngine.runOneTurn
 *
 * 单并发：claimNextRunnable 已经在事务内保证全局只有一个 PREPARING；
 * 项目锁由 acquireProjectLock 保证同一目录不被并发写。
 *
 * 错误分类：
 *   额度耗尽  -> WAITING_QUOTA（由 TaskEngine 内部已处理状态转换）
 *   认证失效  -> WAITING_AUTH
 *   其他失败  -> FAILED_RETRYABLE，按退避重排
 */

import { AppServerClient } from "@car/app-server-client";
import type { Logger } from "@car/logger";
import { SqliteRepository } from "@car/persistence";
import type { ManagedTask } from "@car/persistence";
import { TaskEngine } from "@car/task-engine";
import { prepareForRun } from "@car/git-guard";
import type { QuotaSnapshot } from "@car/quota-engine";
import { randomUUID } from "node:crypto";

export interface SchedulerOptions {
  client: AppServerClient;
  repo: SqliteRepository;
  engine: TaskEngine;
  logger: Logger;
  isAutoRunEnabled: () => boolean;
  getQuotaSnapshot: () => QuotaSnapshot | null;
  refreshQuotaSnapshot?: () => Promise<QuotaSnapshot | null>;
}

export class Scheduler {
  private readonly client: AppServerClient;
  private readonly repo: SqliteRepository;
  private readonly engine: TaskEngine;
  private readonly log: Logger;
  private readonly isAutoRunEnabled: () => boolean;
  private readonly getQuotaSnapshot: () => QuotaSnapshot | null;
  private readonly refreshQuotaSnapshot?: () => Promise<QuotaSnapshot | null>;
  private tickTimer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(opts: SchedulerOptions) {
    this.client = opts.client;
    this.repo = opts.repo;
    this.engine = opts.engine;
    this.log = opts.logger.child({ comp: "scheduler" });
    this.isAutoRunEnabled = opts.isAutoRunEnabled;
    this.getQuotaSnapshot = opts.getQuotaSnapshot;
    this.refreshQuotaSnapshot = opts.refreshQuotaSnapshot;
  }

  /** 启动周期性 tick（默认每 30 秒） */
  start(intervalMs = 30_000): void {
    this.scheduleTick(2_000);
    this.tickTimer = setInterval(() => void this.tick().catch((e) => this.log.error("tick error", { err: String(e) })), intervalMs);
    if (typeof this.tickTimer.unref === "function") this.tickTimer.unref();
  }

  stop(): void {
    if (this.tickTimer) clearInterval(this.tickTimer);
    this.tickTimer = null;
  }

  /** 额度恢复后由 QuotaWatcher 调用 */
  async onQuotaRecovered(): Promise<void> {
    this.log.info("onQuotaRecovered -> tick");
    await this.tick();
  }

  /** 手动触发运行某任务 */
  async runNow(taskId: string): Promise<void> {
    const task = this.repo.getTask(taskId);
    if (!task) throw new Error("task not found: " + taskId);
    // 强制改为 READY 以便 claim
    if (task.status === "READY" || task.status === "NEEDS_CONTINUE" || task.status === "WAITING_QUOTA" || task.status === "WAITING_SCHEDULE") {
      this.repo.forceStatus(taskId, "READY");
    }
    await this.tick();
  }

  private scheduleTick(delay: number): void {
    setTimeout(() => void this.tick().catch((e) => this.log.error("scheduled tick error", { err: String(e) })), delay);
  }

  /** 核心调度逻辑 */
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      if (!this.isAutoRunEnabled()) return;
      if (!this.client.isHealthy()) {
        this.log.debug("skip: app-server not healthy");
        return;
      }
      if (this.repo.hasRunningTask()) return;

      // 额度检查
      const quota = this.getQuotaSnapshot();
      if (quota) {
        let effectiveQuota = quota;
        if (effectiveQuota.status === "exhausted" || effectiveQuota.status === "auth_required" || effectiveQuota.status === "unknown") {
          if (quota.status === "exhausted" && await this.tryUseResetCreditForWeeklyLimit(quota)) {
            const refreshed = await this.refreshQuotaSnapshot?.();
            if (refreshed) effectiveQuota = refreshed;
          } else {
            return;
          }
        }
        if (effectiveQuota.status === "exhausted" || effectiveQuota.status === "auth_required" || effectiveQuota.status === "unknown") {
          return;
        }
        // available / near_limit -> 继续
      }

      // 认领最高优先级
      const task = this.repo.claimNextRunnable();
      if (!task) return;

      this.log.info("claiming task", { id: task.id, title: task.title, priority: task.priority });
      await this.runTask(task);
    } finally {
      this.running = false;
    }
  }

  private async runTask(task: ManagedTask): Promise<void> {
    const log = this.log.child({ taskId: task.id });
    // 项目锁
    if (!this.repo.acquireProjectLock(task.projectPath, task.id, null)) {
      log.warn("project locked elsewhere; back to WAITING_USER");
      this.repo.forceStatus(task.id, "WAITING_USER");
      this.repo.patch(task.id, { lastError: "project locked", nextRunAt: Date.now() + 5 * 60_000 });
      return;
    }
    // git 准备
    const prep = prepareForRun(task.projectPath, { allowDirty: task.workspaceMode === "worktree" });
    if (!prep.ok) {
      log.warn("git prepare failed", { reason: prep.reason });
      this.repo.forceStatus(task.id, "WAITING_USER");
      this.repo.patch(task.id, { lastError: prep.reason ?? "git guard" });
      this.repo.releaseProjectLock(task.projectPath);
      return;
    }

    try {
      const outcome = await this.engine.runOneTurn(task);
      log.info("turn outcome", { status: outcome.status });
    } catch (e) {
      log.error("runOneTurn threw", { err: String(e) });
      // 兜底：如果还停在 RUNNING/VERIFYING 等，推进到 FAILED_RETRYABLE
      const cur = this.repo.getTask(task.id);
      if (cur && ["PREPARING", "STARTING_THREAD", "RUNNING", "VERIFYING"].includes(cur.status)) {
        this.repo.forceStatus(task.id, "FAILED_RETRYABLE");
        this.repo.patch(task.id, { lastError: String(e), retryCount: cur.retryCount + 1, nextRunAt: Date.now() + 60_000 });
      }
    } finally {
      this.repo.releaseProjectLock(task.projectPath);
    }
  }

  private async tryUseResetCreditForWeeklyLimit(quota: QuotaSnapshot): Promise<boolean> {
    if (!isWeeklyLimitExhausted(quota)) return false;
    if ((quota.resetCreditsAvailable ?? 0) <= 0) return false;
    const task = this.repo.listResetCreditEligibleTasks().find((t) => canAttemptResetCredit(t));
    if (!task) return false;

    const now = Date.now();
    const idempotencyKey = `car-${task.id}-${randomUUID()}`;
    this.repo.patch(task.id, {
      resetCreditLastAttemptAt: now,
      resetCreditLastOutcome: "pending",
    });
    this.repo.appendEvent(task.id, "quota/reset-credit/attempt", { idempotencyKey, resetCreditsAvailable: quota.resetCreditsAvailable });

    try {
      const resp = await this.client.request<{ outcome?: "reset" | "nothingToReset" | "noCredit" | "alreadyRedeemed" }>(
        "account/rateLimitResetCredit/consume",
        { idempotencyKey },
      );
      const outcome = resp.outcome ?? "unknown";
      this.repo.patch(task.id, { resetCreditLastOutcome: outcome });
      this.repo.appendEvent(task.id, "quota/reset-credit/outcome", { outcome });
      this.log.warn("reset credit consume outcome", { taskId: task.id, outcome });
      if (outcome === "reset" || outcome === "alreadyRedeemed") {
        if (task.status === "WAITING_QUOTA" || task.status === "NEEDS_CONTINUE" || task.status === "READY") {
          this.repo.forceStatus(task.id, "READY");
          this.repo.patch(task.id, { nextRunAt: Date.now() + 10_000, lastError: null });
        }
        return true;
      }
      return false;
    } catch (e) {
      const err = String(e);
      this.repo.patch(task.id, { resetCreditLastOutcome: "error", lastError: err });
      this.repo.appendEvent(task.id, "quota/reset-credit/error", { error: err });
      this.log.error("reset credit consume failed", { taskId: task.id, err });
      return false;
    }
  }
}

function isWeeklyLimitExhausted(quota: QuotaSnapshot): boolean {
  return quota.blockingBuckets.some((b) => {
    const secondary = b.secondary;
    if (!secondary || secondary.usedPercent == null || secondary.usedPercent < 100) return false;
    return secondary.windowDurationMins == null || secondary.windowDurationMins >= 7 * 24 * 60;
  });
}

function canAttemptResetCredit(task: ManagedTask): boolean {
  if (!task.useResetCreditOnWeeklyLimit) return false;
  if (task.resetCreditLastAttemptAt == null) return true;
  return Date.now() - task.resetCreditLastAttemptAt > 60 * 60_000;
}
