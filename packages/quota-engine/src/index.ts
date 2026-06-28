/**
 * 额度引擎。
 *
 * 输入：account/read 与 account/rateLimits/read 的真实返回（见 @car/protocol-schema）。
 * 输出：归一化的 QuotaSnapshot —— 状态、桶列表、阻塞桶、下一可执行时间、下一检查时间。
 *
 * 核心规则（文档第 10 节）：
 *  - 阻塞桶 = rateLimitReachedType 非空 OR primary/secondary.usedPercent >= 100
 *  - nextEligibleAt = max(阻塞桶 resetsAt) + safetyBuffer
 *  - 到达 nextEligibleAt 仅是「唤醒时间」，不等于「可执行证明」，daemon 必须二次读取校验
 *  - 没有有效 resetsAt 时，退避 10 分钟
 */

import type {
  AccountInfo,
  RateLimitsResult,
  RateLimitBucketRaw,
  RateLimitWindow,
} from "@car/protocol-schema";
import type { QuotaStatus } from "@car/shared-types";
import { randomInt } from "node:crypto";

export interface NormalizedBucket {
  limitId: string;
  limitName: string | null;
  primary: RateLimitWindow | null;
  secondary: RateLimitWindow | null;
  credits: { hasCredits: boolean; unlimited: boolean } | null;
  planType: string | null;
  rateLimitReachedType: string | null;
}

export interface QuotaSnapshot {
  /** 认证模式：chatgpt | api_billing | unknown（未登录由调用方另行处理） */
  mode: "chatgpt" | "api_billing" | "unknown";
  status: QuotaStatus;
  buckets: NormalizedBucket[];
  blockingBuckets: NormalizedBucket[];
  /** 顶层 usedPercent（若有） */
  usedPercent: number | null;
  /** 下一可执行时间（ms），null 表示未知/需退避 */
  nextEligibleAt: number | null;
  /** 下一建议读取检查时间（ms） */
  nextCheckAt: number;
  /** 捕获时间（ms） */
  capturedAt: number;
  /** 可用重置积分（若有） */
  resetCreditsAvailable: number | null;
}

const MS = 1000;
const DEFAULT_FALLBACK_DELAY_MS = 10 * 60 * 1000;

export interface QuotaComputeOptions {
  /** 近额度阈值，默认 90（来自配置） */
  nearLimitPercent?: number;
  /** 安全缓冲秒，默认 30 */
  safetyBufferSeconds?: number;
  /** 当前时间（ms），默认 Date.now()；用于测试 */
  now?: number;
}

/**
 * 从 account/read 解析认证模式。
 * v0.142.3: { account: { type: "chatgpt" | "api_key" | ..., ... }, requiresOpenaiAuth }
 */
export function deriveAuthMode(account: AccountInfo | undefined): "chatgpt" | "api_billing" | "none" | "unknown" {
  if (!account) return "unknown";
  const t = account.account?.type?.toLowerCase();
  if (t === "chatgpt") return "chatgpt";
  if (t === "api_key" || t === "apikey") return "api_billing";
  if (account.requiresOpenaiAuth === false && !t) return "none";
  if (!t) return "unknown";
  return "unknown";
}

/** 把各种可能的 rateLimits 形状归一化为桶列表（来自 map 优先） */
export function parseBuckets(rl: RateLimitsResult): NormalizedBucket[] {
  const list: NormalizedBucket[] = [];
  const seen = new Set<string>();
  const add = (b: RateLimitBucketRaw | null | undefined) => {
    if (!b || typeof b !== "object") return;
    const id = b.limitId ?? anonymousId(list.length);
    const norm: NormalizedBucket = {
      limitId: id,
      limitName: b.limitName ?? null,
      primary: b.primary ?? null,
      secondary: b.secondary ?? null,
      credits: b.credits
        ? { hasCredits: !!b.credits.hasCredits, unlimited: !!b.credits.unlimited }
        : null,
      planType: b.planType ?? null,
      rateLimitReachedType: b.rateLimitReachedType ?? null,
    };
    if (!seen.has(id)) {
      seen.add(id);
      list.push(norm);
    }
  };
  // 优先用 map（v0.142.3 存在 rateLimitsByLimitId）
  if (rl.rateLimitsByLimitId && typeof rl.rateLimitsByLimitId === "object") {
    for (const b of Object.values(rl.rateLimitsByLimitId)) add(b);
  }
  const r = rl.rateLimits;
  if (r) {
    if (Array.isArray(r)) for (const b of r) add(b);
    else if (typeof r === "object") add(r as RateLimitBucketRaw);
  }
  return list;
}

function anonymousId(i: number): string {
  return `__anon_${i}`;
}

/** 该窗口是否已耗尽 */
function windowFull(w: RateLimitWindow | null): boolean {
  return w != null && w.usedPercent != null && w.usedPercent >= 100;
}

/** 判定桶是否阻塞 */
export function isBucketBlocking(b: NormalizedBucket): boolean {
  if (b.rateLimitReachedType != null && b.rateLimitReachedType !== "") return true;
  return windowFull(b.primary) || windowFull(b.secondary);
}

/** 该窗口是否近额度（>= threshold，但 < 100） */
function windowNearLimit(w: RateLimitWindow | null, threshold: number): boolean {
  if (!w || w.usedPercent == null) return false;
  return w.usedPercent >= threshold && w.usedPercent < 100;
}

function windowResetsAtMs(w: RateLimitWindow | null): number | null {
  if (!w || w.resetsAt == null) return null;
  return w.resetsAt * MS;
}

/**
 * 计算完整的 QuotaSnapshot。
 */
export function computeQuotaSnapshot(
  account: AccountInfo | undefined,
  rl: RateLimitsResult | undefined,
  opts: QuotaComputeOptions = {},
): QuotaSnapshot {
  const now = opts.now ?? Date.now();
  const nearLimit = opts.nearLimitPercent ?? 90;
  const safetyMs = (opts.safetyBufferSeconds ?? 30) * MS;

  const derivedMode = deriveAuthMode(account);
  // QuotaSnapshot.mode 不含 "none"：未登录时一律记 unknown + auth_required
  const mode: "chatgpt" | "api_billing" | "unknown" =
    derivedMode === "none" ? "unknown" : derivedMode;
  const buckets = rl ? parseBuckets(rl) : [];
  const blockingBuckets = buckets.filter(isBucketBlocking);

  // 顶层 usedPercent：优先桶内 primary；否则回退顶层字段
  let usedPercent: number | null = null;
  if (rl?.usedPercent != null) usedPercent = rl.usedPercent;
  else if (buckets.length) usedPercent = buckets[0]?.primary?.usedPercent ?? null;

  let status: QuotaStatus;
  if (derivedMode === "none") {
    status = "auth_required";
  } else if (blockingBuckets.length > 0) {
    status = "exhausted";
  } else if (buckets.some((b) => windowNearLimit(b.primary, nearLimit) || windowNearLimit(b.secondary, nearLimit))) {
    status = "near_limit";
  } else if (buckets.length > 0) {
    status = "available";
  } else {
    status = "unknown";
  }

  // nextEligibleAt：只采用真正达到 100% 的窗口的 resetsAt（+ 安全缓冲）。
  // 排除未阻塞窗口的 resetsAt —— 否则用 7 天窗口的阈值的远期 reset 会让工具白等。
  // 若 reachedType 置位但无窗口达 100%（边缘情况），回退到桶最近 resetsAt。
  let nextEligibleAt: number | null = null;
  if (blockingBuckets.length > 0) {
    const resets: number[] = [];
    for (const b of blockingBuckets) {
      if (windowFull(b.primary)) if (windowResetsAtMs(b.primary) != null) resets.push(windowResetsAtMs(b.primary)!);
      if (windowFull(b.secondary)) if (windowResetsAtMs(b.secondary) != null) resets.push(windowResetsAtMs(b.secondary)!);
      if (!windowFull(b.primary) && !windowFull(b.secondary)) {
        // reachedType set but数值未到 100：取桶内最早 resetsAt
        const ps = windowResetsAtMs(b.primary);
        const ss = windowResetsAtMs(b.secondary);
        const earliest = [ps, ss].filter((x): x is number => x != null).sort((a, b2) => a - b2)[0];
        if (earliest != null) resets.push(earliest);
      }
    }
    if (resets.length > 0) {
      nextEligibleAt = Math.max(...resets) + safetyMs;
    } else {
      nextEligibleAt = now + DEFAULT_FALLBACK_DELAY_MS;
    }
  } else if (status === "available" || status === "near_limit") {
    nextEligibleAt = now;
  } else {
    nextEligibleAt = null;
  }

  const nextCheckAt = computeNextCheckAt(status, now, nextEligibleAt);

  return {
    mode,
    status,
    buckets,
    blockingBuckets,
    usedPercent,
    nextEligibleAt,
    nextCheckAt,
    capturedAt: now,
    resetCreditsAvailable: rl?.rateLimitResetCredits?.availableCount ?? null,
  };
}

/** 下一检查时间（文档 10.5）——返回 ms 时间戳 */
export function computeNextCheckAt(status: QuotaStatus, now: number, nextEligibleAt: number | null): number {
  switch (status) {
    case "available":
      return now + 10 * 60 * MS;
    case "near_limit":
      return now + 2 * 60 * MS;
    case "exhausted": {
      if (nextEligibleAt != null) return Math.min(nextEligibleAt, now + 15 * 60 * MS);
      return now + 15 * 60 * MS;
    }
    case "auth_required":
      return now + 30 * 60 * MS;
    case "unknown": {
      // 1、3、10、30、60 分钟退避由调用方累积；这里给最短
      return now + 60 * MS;
    }
    default:
      return now + 5 * 60 * MS;
  }
}

/** 当前是否到达唤醒时间 */
export function isEligibleToRecheck(snap: QuotaSnapshot, now = Date.now()): boolean {
  return snap.nextEligibleAt != null && now >= snap.nextEligibleAt;
}

/** 恢复后的随机抖动（避免多机/多进程同时复活冲撞） */
export function jitterMs(minSec = 15, maxSec = 45): number {
  return randomInt(minSec, maxSec + 1) * MS;
}

/** 人类可读倒计时 */
export function describeUntil(ts: number | null, now = Date.now()): string {
  if (ts == null) return "未知";
  const ms = ts - now;
  if (ms <= 0) return "已到点";
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h${m}m${sec}s`;
  if (m > 0) return `${m}m${sec}s`;
  return `${sec}s`;
}