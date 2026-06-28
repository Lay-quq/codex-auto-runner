/**
 * 协议探针（阶段 1）。
 *
 * 目标：真实拉起 codex app-server，完成握手，读取账号与额度接口，
 * 并监听一段时间额度更新通知，输出诊断结论。退出码 0 表示协议链路可行。
 */

import { AppServerClient } from "@car/app-server-client";
import { resolveCodex } from "@car/codex-resolver";
import { createLogger } from "@car/logger";
import type { AccountInfo, RateLimitsResult } from "@car/protocol-schema";

function tsToLocal(unixSeconds: number | null | undefined): string | null {
  if (unixSeconds == null) return null;
  const d = new Date(unixSeconds * 1000);
  return d.toLocaleString();
}

function ratio(p?: number | null): string {
  if (p == null) return "n/a";
  return p.toFixed(1) + "%";
}

async function main(): Promise<void> {
  const log = createLogger({ level: "info" });
  const listenSec = Number(process.env.CAR_PROBE_LISTEN_SEC ?? "8");

  log.info("probe: resolving codex");
  const codex = await resolveCodex(log);
  log.info("probe: codex resolved", { ...codex });

  const client = new AppServerClient({ codexPath: codex.path, logger: log });

  const notifications: { method: string; t: number }[] = [];
  client.on("notification", (method: string) => {
    notifications.push({ method, t: Date.now() });
  });
  client.on("stderr", (line: string) => {
    log.warn("probe stderr", { line });
  });
  client.on("disconnected", (r) => {
    log.error("probe: disconnected", r);
  });

  await client.start();
  log.info("probe: handshake ok", client.diagnostics as Record<string, unknown>);

  let account: AccountInfo;
  let rateLimits: RateLimitsResult;
  try {
    account = await client.getAccount();
  } catch (e) {
    log.error("probe: account/read failed", { err: String(e) });
    await client.close();
    process.exit(3);
  }
  try {
    rateLimits = await client.getRateLimits();
  } catch (e) {
    log.error("probe: account/rateLimits/read failed", { err: String(e) });
    await client.close();
    process.exit(4);
  }

  // 人类可读结论（写 stdout，日志走 stderr）
  process.stdout.write("\n[RAW account/read]\n" + JSON.stringify(redactAccount(account), null, 2) + "\n");
  process.stdout.write("\n[RAW account/rateLimits/read]\n" + JSON.stringify(rateLimits, null, 2) + "\n");
  const report = buildReport(codex, client, account, rateLimits);
  process.stdout.write("\n========== PROTOCOL PROBE REPORT ==========\n");
  process.stdout.write(report);
  process.stdout.write("\n");

  // 监听一段时间额度更新通知
  if (listenSec > 0) {
    process.stdout.write(`\n[Listening for rate-limit notifications for ${listenSec}s...]\n`);
    await new Promise((r) => setTimeout(r, listenSec * 1000));
    const limitEvents = notifications.filter((n) => n.method === "account/rateLimits/updated");
    process.stdout.write(`notifications seen: total=${notifications.length} rateLimits.updated=${limitEvents.length}\n`);
    if (notifications.length) {
      const counts: Record<string, number> = {};
      for (const n of notifications) counts[n.method] = (counts[n.method] ?? 0) + 1;
      process.stdout.write(JSON.stringify(counts, null, 2) + "\n");
    }
  }

  await client.close();

  // 结论：能够拿到结构化额度桶即视为协议链路可行
  const bucketsSeen = flattenBuckets(rateLimits).length;
  const ok = bucketsSeen > 0;
  process.stdout.write(`\nPROBE_RESULT: ${ok ? "OK" : "FAIL"}\n`);
  process.exit(ok ? 0 : 5);
}

function redactAccount(a: AccountInfo): unknown {
  // 去掉明显敏感字段后回显结构
  const { account_id, ...rest } = a as Record<string, unknown>;
  void account_id;
  return rest;
}

function flattenBuckets(rl: RateLimitsResult): { id: string; name: string | null; raw: unknown }[] {
  const out: { id: string; name: string | null; raw: unknown }[] = [];
  const rlAny = rl as unknown;
  if (Array.isArray((rlAny as { rateLimits?: unknown[] }).rateLimits)) {
    const arr = (rl as { rateLimits: Record<string, unknown>[] }).rateLimits;
    for (const b of arr) out.push({ id: String(b?.limitId ?? "?"), name: (b?.limitName as string) ?? null, raw: b });
  }
  // rateLimitsByLimitId 可能是对象
  const map = (rl as { rateLimitsByLimitId?: Record<string, Record<string, unknown>> }).rateLimitsByLimitId;
  if (map && typeof map === "object") {
    for (const [id, b] of Object.entries(map)) out.push({ id, name: (b?.limitName as string) ?? null, raw: b });
  }
  return out;
}

function buildReport(
  codex: { path: string; version: string | null; source: string; staged: boolean },
  client: AppServerClient,
  account: AccountInfo,
  rl: RateLimitsResult,
): string {
  const lines: string[] = [];
  lines.push(`codex.path        = ${codex.path}`);
  lines.push(`codex.version     = ${codex.version ?? "unknown"}`);
  lines.push(`codex.source      = ${codex.source}${codex.staged ? " (staged)" : ""}`);
  lines.push(`server.protocol    = ${client.diagnostics.serverProtocolVersion ?? "unknown"}`);
  lines.push(`server.name        = ${client.diagnostics.serverName ?? "unknown"}`);
  lines.push(`server.version     = ${client.diagnostics.serverVersion ?? "unknown"}`);
  lines.push("");
  lines.push(`account.type       = ${account.account?.type ?? "unknown"}`);
  lines.push(`account.planType   = ${account.account?.planType ?? "unknown"}`);
  lines.push(`requiresOpenaiAuth = ${account.requiresOpenaiAuth ?? "unknown"}`);
  lines.push("");
  lines.push("--- rate limits (top-level) ---");
  lines.push(`usedPercent        = ${ratio(rl.usedPercent)}`);
  lines.push(`windowDurationMins = ${rl.windowDurationMins ?? "n/a"}`);
  lines.push(`resetsAt(unix)     = ${rl.resetsAt ?? "n/a"}`);
  lines.push(`resetsAt(local)    = ${tsToLocal(rl.resetsAt) ?? "n/a"}`);
  lines.push(`rateLimitReached   = ${rl.rateLimitReachedType ?? "null"}`);
  lines.push("");
  const buckets = flattenBuckets(rl);
  lines.push(`--- rate limit buckets: ${buckets.length} ---`);
  buckets.forEach((b, i) => {
    lines.push(`bucket[${i}]: id=${b.id} name=${b.name ?? "?"}`);
    const raw = b.raw as { primary?: Record<string, unknown>; secondary?: Record<string, unknown>; rateLimitReachedType?: string | null };
    if (raw?.rateLimitReachedType != null) lines.push(`  reachedType = ${raw.rateLimitReachedType}`);
    const pr = raw?.primary;
    const sc = raw?.secondary;
    if (pr) lines.push(`  primary  : ${JSON.stringify(pr)}`);
    if (sc) lines.push(`  secondary: ${JSON.stringify(sc)}`);
  });
  return lines.join("\n");
}

main().catch((e) => {
  process.stderr.write("probe fatal: " + (e?.stack ?? String(e)) + "\n");
  process.exit(1);
});