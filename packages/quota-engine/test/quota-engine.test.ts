import { describe, it, expect } from "vitest";
import {
  computeQuotaSnapshot,
  deriveAuthMode,
  isBucketBlocking,
  parseBuckets,
  jitterMs,
} from "../src/index.js";
import type { RateLimitsResult, AccountInfo } from "@car/protocol-schema";

const NOW = 1_700_000_000_000;

function acct(type?: string, plan?: string, requiresOpenaiAuth = true): AccountInfo {
  return { account: type ? { type, planType: plan } : undefined, requiresOpenaiAuth };
}

// v0.142.3 真实结构
function rl(opts: {
  primary?: { usedPercent?: number | null; resetsAt?: number | null; window?: number };
  secondary?: { usedPercent?: number | null; resetsAt?: number | null; window?: number };
  reached?: string | null;
  limitId?: string;
  topUsed?: number | null;
  resetCredits?: number;
  byMap?: boolean;
}): RateLimitsResult {
  const bucket: Record<string, unknown> = {
    limitId: opts.limitId ?? "codex",
    limitName: null,
    primary: opts.primary
      ? {
          usedPercent: opts.primary.usedPercent ?? null,
          windowDurationMins: opts.primary.window ?? null,
          resetsAt: opts.primary.resetsAt ?? null,
        }
      : null,
    secondary: opts.secondary
      ? {
          usedPercent: opts.secondary.usedPercent ?? null,
          windowDurationMins: opts.secondary.window ?? null,
          resetsAt: opts.secondary.resetsAt ?? null,
        }
      : null,
    credits: { hasCredits: false, unlimited: false, balance: "0" },
    individualLimit: null,
    planType: "plus",
    rateLimitReachedType: opts.reached ?? null,
  };
  const out: RateLimitsResult = {};
  out.rateLimits = opts.byMap ? undefined : (bucket as never);
  out.rateLimitsByLimitId = { codex: bucket as never };
  if (typeof opts.topUsed !== "undefined") out.usedPercent = opts.topUsed;
  if (typeof opts.resetCredits !== "undefined")
    out.rateLimitResetCredits = { availableCount: opts.resetCredits };
  return out;
}

describe("deriveAuthMode", () => {
  it("chatgpt", () => {
    expect(deriveAuthMode(acct("chatgpt", "plus"))).toBe("chatgpt");
  });
  it("api_key -> api_billing", () => {
    expect(deriveAuthMode(acct("api_key"))).toBe("api_billing");
  });
  it("none when no auth required and no type", () => {
    expect(deriveAuthMode(acct(undefined, undefined, false))).toBe("none");
  });
  it("unknown when missing", () => {
    expect(deriveAuthMode(undefined)).toBe("unknown");
  });
});

describe("parseBuckets (v0.142.3 single-object shape)", () => {
  it("parses map and object, dedupes by limitId", () => {
    const r = rl({ primary: { usedPercent: 42 } });
    const bs = parseBuckets(r);
    expect(bs.length).toBe(1);
    expect(bs[0]?.limitId).toBe("codex");
    expect(bs[0]?.primary?.usedPercent).toBe(42);
  });
});

describe("isBucketBlocking", () => {
  it("blocks on reachedType", () => {
    const s = computeQuotaSnapshot(acct("chatgpt"), rl({ reached: "rate_limit_reached", primary: { usedPercent: 50 } }), { now: NOW });
    expect(s.status).toBe("exhausted");
    expect(s.blockingBuckets.length).toBe(1);
  });
  it("blocks on primary 100", () => {
    const s = computeQuotaSnapshot(acct("chatgpt"), rl({ primary: { usedPercent: 100, resetsAt: 12345, window: 300 } }), { now: NOW });
    expect(s.status).toBe("exhausted");
  });
  it("blocks on secondary 100", () => {
    const s = computeQuotaSnapshot(acct("chatgpt"), rl({ primary: { usedPercent: 10 }, secondary: { usedPercent: 100, resetsAt: 999, window: 10080 } }), { now: NOW });
    expect(s.status).toBe("exhausted");
  });
});

describe("status classification", () => {
  it("0% -> available", () => {
    const s = computeQuotaSnapshot(acct("chatgpt"), rl({ primary: { usedPercent: 0 } }), { now: NOW });
    expect(s.status).toBe("available");
  });
  it("89% -> available", () => {
    const s = computeQuotaSnapshot(acct("chatgpt"), rl({ primary: { usedPercent: 89 } }), { now: NOW });
    expect(s.status).toBe("available");
  });
  it("90% -> near_limit", () => {
    const s = computeQuotaSnapshot(acct("chatgpt"), rl({ primary: { usedPercent: 90 } }), { now: NOW });
    expect(s.status).toBe("near_limit");
  });
  it("no buckets -> unknown", () => {
    const s = computeQuotaSnapshot(acct("chatgpt"), {}, { now: NOW });
    expect(s.status).toBe("unknown");
  });
  it("missing auth -> auth_required (overrides everything)", () => {
    const s = computeQuotaSnapshot(acct(undefined, undefined, false), rl({ primary: { usedPercent: 100 }, reached: "rate_limit_reached" }), { now: NOW });
    expect(s.status).toBe("auth_required");
  });
});

describe("nextEligibleAt", () => {
  it("uses resetsAt of full windows only + safety (primary 100, secondary 87 -> only primary)", () => {
    const s = computeQuotaSnapshot(
      acct("chatgpt"),
      rl({ primary: { usedPercent: 100, resetsAt: 100, window: 300 }, secondary: { usedPercent: 87, resetsAt: 200, window: 10080 }, reached: "x" }),
      { now: NOW, safetyBufferSeconds: 30 },
    );
    // secondary 87% 不是阻塞窗口，不应使用其 7 天 reset
    expect(s.nextEligibleAt).toBe(100 * 1000 + 30 * 1000);
  });
  it("max of both full windows resets when both at 100", () => {
    const s = computeQuotaSnapshot(
      acct("chatgpt"),
      rl({ primary: { usedPercent: 100, resetsAt: 100, window: 300 }, secondary: { usedPercent: 100, resetsAt: 200, window: 10080 }, reached: "x" }),
      { now: NOW, safetyBufferSeconds: 30 },
    );
    expect(s.nextEligibleAt).toBe(200 * 1000 + 30 * 1000);
  });
  it("no resetsAt -> now + 10min", () => {
    const s = computeQuotaSnapshot(acct("chatgpt"), rl({ primary: { usedPercent: 100 } }), { now: NOW });
    expect(s.nextEligibleAt).toBe(NOW + 10 * 60_000);
  });
  it("available -> nextEligibleAt = now", () => {
    const s = computeQuotaSnapshot(acct("chatgpt"), rl({ primary: { usedPercent: 10 } }), { now: NOW });
    expect(s.nextEligibleAt).toBe(NOW);
  });
});

describe("nextCheckAt", () => {
  it("available -> +10min", () => {
    const s = computeQuotaSnapshot(acct("chatgpt"), rl({ primary: { usedPercent: 10 } }), { now: NOW });
    expect(s.nextCheckAt - NOW).toBe(10 * 60_000);
  });
  it("near_limit -> +2min", () => {
    const s = computeQuotaSnapshot(acct("chatgpt"), rl({ primary: { usedPercent: 90 } }), { now: NOW });
    expect(s.nextCheckAt - NOW).toBe(2 * 60_000);
  });
});

describe("jitter", () => {
  it("within range", () => {
    for (let i = 0; i < 50; i++) {
      const j = jitterMs(15, 45);
      expect(j).toBeGreaterThanOrEqual(15_000);
      expect(j).toBeLessThanOrEqual(45_000);
    }
  });
});

describe("real-world snapshot (v0.142.3)", () => {
  it("matches captured prod data", () => {
    const s = computeQuotaSnapshot(
      acct("chatgpt", "plus"),
      rl({ primary: { usedPercent: 100, resetsAt: 1782574311, window: 300 }, secondary: { usedPercent: 87, resetsAt: 1782813846, window: 10080 }, reached: "rate_limit_reached", resetCredits: 1 }),
      { now: NOW, safetyBufferSeconds: 30 },
    );
    expect(s.status).toBe("exhausted");
    expect(s.mode).toBe("chatgpt");
    expect(s.resetCreditsAvailable).toBe(1);
    expect(s.usedPercent).toBe(100);
    expect(s.blockingBuckets.length).toBe(1);
    expect(isBucketBlocking(s.blockingBuckets[0]!)).toBe(true);
  });
});