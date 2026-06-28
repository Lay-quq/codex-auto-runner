/**
 * QuotaWatcher —— 额度监测与恢复闭环。
 *
 * 流程（文档第 10.6 / 37 节）：
 *   连接 App Server
 *   → 读取账号 & 额度
 *   → exhausted 时，按 nextEligibleAt 设置唤醒定时器 + nextCheckAt 兜底轮询
 *   → 到点：重新读取账号 & 额度（二次验证）
 *        仍 exhausted：重新计算时间，继续等待
 *        available/near_limit：随机抖动 15–45s → 再读一次 → 仍可用：触发 onRecovered()
 *   → 订阅 account/rateLimits/updated：收到即尽快重新读取（事件驱动刷新）
 *   → 状态变化时写入 status 文件供 UI/CLI 读取
 *
 * onRecovered 钩子：恢复后由任务引擎接管「启动进行中/目标任务」。
 *   未配置时仅记录并继续监测下一周期。
 */

import { AppServerClient } from "@car/app-server-client";
import type { Logger } from "@car/logger";
import { computeQuotaSnapshot, jitterMs, describeUntil, type QuotaSnapshot } from "@car/quota-engine";
import type { AccountInfo, RateLimitsResult } from "@car/protocol-schema";
import type { RunnerConfig } from "@car/shared-types";
import { writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { EventEmitter } from "node:events";

export interface QuotaWatcherEvents {
  snapshot: (snap: QuotaSnapshot) => void;
  statusChange: (from: QuotaSnapshot["status"], to: QuotaSnapshot["status"]) => void;
  recovered: () => void;
}

export interface QuotaWatcherOptions {
  client: AppServerClient;
  config: RunnerConfig;
  logger: Logger;
  /** 状态文件路径（UI/CLI 读取）。不传则不写文件 */
  statusFile?: string;
  /** 恢复后回调（任务引擎在此启动队列）。可选 */
  onRecovered?: () => Promise<void>;
  /** 仅用于测试：覆盖 jitter 范围 */
  jitter?: { min: number; max: number };
  /** 仅用于测试：如需快速演示，可设 true 启用恢复时的详细心跳 */
  verboseRecovery?: boolean;
}

export class QuotaWatcher extends EventEmitter {
  private readonly client: AppServerClient;
  private readonly cfg: RunnerConfig;
  private readonly log: Logger;
  private readonly statusFile?: string;
  private readonly onRecoveredCb?: () => Promise<void>;
  private readonly jitterRange: { min: number; max: number };

  private timer: NodeJS.Timeout | null = null;
  private last: QuotaSnapshot | null = null;
  private stopped = false;
  private refreshing = false;

  constructor(opts: QuotaWatcherOptions) {
    super();
    this.client = opts.client;
    this.cfg = opts.config;
    this.log = opts.logger.child({ comp: "quota-watcher" });
    this.statusFile = opts.statusFile;
    this.onRecoveredCb = opts.onRecovered;
    this.jitterRange = opts.jitter ?? {
      min: this.cfg.quota.jitterMinSeconds,
      max: this.cfg.quota.jitterMaxSeconds,
    };
  }

  async start(): Promise<void> {
    // 订阅额度更新通知
    this.client.on("notification", (method: string) => {
      if (method === "account/rateLimits/updated") {
        this.log.debug("rateLimits.updated notification -> refresh soon");
        this.scheduleRefreshSoon();
      }
    });
    await this.refresh();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /** 立即刷新一次额度快照 */
  async refresh(): Promise<QuotaSnapshot | null> {
    if (this.refreshing) return this.last;
    this.refreshing = true;
    try {
      const account = await this.client.getAccount().catch((e: unknown) => {
        this.log.warn("account/read failed", { err: String(e) });
        return undefined as AccountInfo | undefined;
      });
      const rl = await this.client.getRateLimits().catch((e: unknown) => {
        this.log.warn("rateLimits/read failed", { err: String(e) });
        return undefined as RateLimitsResult | undefined;
      });
      const snap = computeQuotaSnapshot(account, rl, {
        now: Date.now(),
        nearLimitPercent: this.cfg.quota.nearLimitPercent,
        safetyBufferSeconds: this.cfg.quota.safetyBufferSeconds,
      });
      const stableSnap = this.stabilizeEmptyUnknownSnapshot(snap);
      this.apply(stableSnap);
      return stableSnap;
    } finally {
      this.refreshing = false;
    }
  }

  private apply(snap: QuotaSnapshot): void {
    const prev = this.last;
    this.last = snap;
    this.emit("snapshot", snap);
    if (prev && prev.status !== snap.status) {
      this.emit("statusChange", prev.status, snap.status);
      this.log.info("quota status changed", { from: prev.status, to: snap.status });
    }
    this.writeStatus(snap);
    this.printHeartbeat(snap);
    this.scheduleNext(snap);
  }

  private stabilizeEmptyUnknownSnapshot(snap: QuotaSnapshot): QuotaSnapshot {
    const prev = this.last;
    const isEmptyUnknown = snap.status === "unknown" && snap.buckets.length === 0 && snap.usedPercent == null;
    const prevIsFresh = prev && prev.buckets.length > 0 && Date.now() - prev.capturedAt < 15 * 60_000;
    if (!isEmptyUnknown || !prevIsFresh) return snap;
    this.log.warn("quota read returned empty unknown snapshot; keeping recent valid quota", {
      previousStatus: prev.status,
      previousUsedPercent: prev.usedPercent,
      previousCapturedAt: prev.capturedAt,
    });
    return {
      ...prev,
      capturedAt: snap.capturedAt,
      nextCheckAt: snap.nextCheckAt,
    };
  }

  private scheduleNext(snap: QuotaSnapshot): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.stopped) return;
    let delay: number;
    if (snap.status === "exhausted" && snap.nextEligibleAt != null) {
      const now = Date.now();
      delay = Math.max(snap.nextEligibleAt - now, 0);
      // 兜底：不超过 15 分钟，发现时间漂移
      delay = Math.min(delay, this.cfg.quota.exhaustedPollFallbackMinutes * 60_000);
    } else {
      delay = Math.max(snap.nextCheckAt - Date.now(), 5_000);
    }
    this.timer = setTimeout(() => this.onTick(), delay);
    if (typeof (this.timer as { unref?: () => void }).unref === "function") {
      (this.timer as { unref: () => void }).unref();
    }
  }

  private scheduleRefreshSoon(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.timer = setTimeout(() => this.onTick(), 3_000);
  }

  private async onTick(): Promise<void> {
    if (this.stopped) return;
    const snap = await this.refresh();
    if (!snap) return;
    if (snap.status !== "exhausted") {
      // 到点且非耗尽：可能是恢复点，二次验证 + 抖动后恢复
      if (this.last && this.needsRecoveryCheck()) {
        await this.recoverSequence();
      }
    }
  }

  private lastWasExhausted = false;
  private needsRecoveryCheck(): boolean {
    const was = this.lastWasExhausted;
    this.lastWasExhausted = this.last?.status === "exhausted";
    return was; // 从 exhausted 转出时触发
  }

  /** 恢复二次验证序列（抖动后再读一次） */
  private async recoverSequence(): Promise<void> {
    const first = this.last;
    if (!first) return;
    this.log.info("quota appears recovered, second verification with jitter", {
      jitter: `${this.jitterRange.min}-${this.jitterRange.max}s`,
    });
    await sleep(jitterMs(this.jitterRange.min, this.jitterRange.max));
    if (this.stopped) return;
    const second = await this.refresh();
    if (!second) return;
    if (second.status === "available" || second.status === "near_limit") {
      this.log.info("quota VERIFIED available", { status: second.status, usedPercent: second.usedPercent });
      this.emit("recovered");
      try {
        await this.onRecoveredCb?.();
      } catch (e) {
        this.log.error("onRecovered hook failed", { err: String(e) });
      }
    } else {
      this.log.warn("second verification still limited, re-scheduling", { status: second.status });
      // 二次验证仍受限，重新进入等待
      this.scheduleNext(second);
    }
  }

  private writeStatus(snap: QuotaSnapshot): void {
    if (!this.statusFile) return;
    try {
      mkdirSync(dirname(this.statusFile), { recursive: true });
      writeFileSync(this.statusFile, JSON.stringify(snap, null, 2));
    } catch {
      /* ignore */
    }
  }

  private printHeartbeat(snap: QuotaSnapshot): void {
    const now = Date.now();
    const lines: string[] = [];
    lines.push(`[${new Date(now).toLocaleTimeString()}] quota=${snap.status} used=${snap.usedPercent ?? "n/a"}% mode=${snap.mode}`);
    for (const b of snap.buckets) {
      const p = b.primary ? `${b.primary.usedPercent ?? "-"}%` : "-";
      const s = b.secondary ? `${b.secondary.usedPercent ?? "-"}%` : "-";
      const reached = b.rateLimitReachedType ?? "";
      lines.push(`  bucket[${b.limitId}] primary=${p} secondary=${s} ${reached}`.trim());
    }
    if (snap.status === "exhausted") {
      lines.push(`  next eligible: ${describeUntil(snap.nextEligibleAt, now)} (resets ${snap.nextEligibleAt ? new Date(snap.nextEligibleAt).toLocaleString() : "n/a"})`);
    }
    this.log.info(lines.join("\n"));
    process.stdout.write(lines.join("\n") + "\n");
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
