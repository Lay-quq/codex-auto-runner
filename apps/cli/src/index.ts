#!/usr/bin/env tsx
/**
 * car — Codex Auto Runner CLI。
 *
 * 命令：
 *   car status                         额度 + 任务概览（读 daemon 的 status.json + DB）
 *   car quota                          仅额度详情
 *   car task add --file task.yaml       从 YAML 添加任务
 *   car task list                       任务列表
 *   car task show <id>                  任务详情
 *   car task pause <id>                 暂停
 *   car task resume <id>               恢复（强制 READY）
 *   car task cancel <id>                取消
 *   car task run-now <id>               立即运行（标记 READY，等 daemon tick）
 *   car daemon start|stop|restart       （占位；真正管理由 Windows 任务计划程序/手动）
 *
 * 说明：pause/resume/run-now 直接写 DB；daemon 的 scheduler 在下个 tick 读取。
 *      若 daemon 未运行，状态仍写入；启动后会被处理。
 */

import { SqliteRepository, defaultDataDir, type CreateTaskInput, TERMINAL_STATUSES } from "@car/persistence";
import type { ManagedTask } from "@car/persistence";
import { join } from "node:path";
import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";

function dataDir(): string {
  return process.env.CAR_DATA_DIR ?? defaultDataDir();
}

function openRepo(): SqliteRepository {
  const repo = new SqliteRepository(join(dataDir(), "runner.db"));
  repo.migrate();
  return repo;
}

function readStatusFile(): unknown | null {
  const f = join(dataDir(), "status.json");
  if (!existsSync(f)) return null;
  try { return JSON.parse(readFileSync(f, "utf8")); } catch { return null; }
}

function parseArgs(argv: string[]): { cmd: string; sub?: string; rest: string[]; opts: Record<string, string> } {
  const args = argv.slice(2);
  const cmd = args[0] ?? "status";
  const sub = args[1] && !args[1].startsWith("-") ? args[1] : undefined;
  const rest = sub ? args.slice(2) : args.slice(1);
  const opts: Record<string, string> = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a && a.startsWith("--")) {
      const key = a.slice(2);
      const next = rest[i + 1];
      if (next && !next.startsWith("--")) { opts[key] = next; i++; }
      else opts[key] = "true";
    }
  }
  return { cmd, sub, rest, opts };
}

async function main(): Promise<void> {
  const { cmd, sub, opts } = parseArgs(process.argv);

  if (cmd === "status") return cmdStatus(opts);
  if (cmd === "quota") return cmdQuota();
  if (cmd === "task") return cmdTask(sub, opts);
  if (cmd === "daemon") return cmdDaemon(sub);

  process.stderr.write(`unknown command: ${cmd}\n`);
  process.stderr.write("commands: status | quota | task | daemon\n");
  process.exit(2);
}

function cmdStatus(_opts: Record<string, string>): void {
  const status = readStatusFile() as { status?: string; usedPercent?: number | null; nextEligibleAt?: number | null; mode?: string } | null;
  if (status) {
    process.stdout.write("=== Quota ===\n");
    process.stdout.write(`  status:     ${status.status ?? "unknown"}\n`);
    process.stdout.write(`  used:       ${status.usedPercent ?? "n/a"}%\n`);
    process.stdout.write(`  mode:       ${status.mode ?? "unknown"}\n`);
    if (status.nextEligibleAt) {
      process.stdout.write(`  next eligible: ${new Date(status.nextEligibleAt).toLocaleString()} (in ${fmtUntil(status.nextEligibleAt)})\n`);
    }
  } else {
    process.stdout.write("Quota: (daemon 未运行或无 status.json)\n");
  }
  process.stdout.write("\n=== Tasks ===\n");
  const repo = openRepo();
  const tasks = repo.listTasks();
  if (!tasks.length) process.stdout.write("  (no tasks)\n");
  else for (const t of tasks) process.stdout.write(fmtTaskLine(t) + "\n");
  repo.close();
}

function cmdQuota(): void {
  const status = readStatusFile();
  process.stdout.write(status ? JSON.stringify(status, null, 2) + "\n" : "(no status.json)\n");
}

function cmdTask(sub: string | undefined, opts: Record<string, string>): void {
  if (sub === "add") return taskAdd(opts);
  if (sub === "list") return taskList();
  if (sub === "show") return taskShow(opts);
  if (sub === "pause") return taskState(opts, "PAUSED");
  if (sub === "resume") return taskState(opts, "READY");
  if (sub === "cancel") return taskState(opts, "CANCELLED");
  if (sub === "run-now") return taskRunNow(opts);
  process.stderr.write(`car task: unknown subcommand: ${sub}\n`);
  process.exit(2);
}

function taskAdd(opts: Record<string, string>): void {
  const file = opts["file"];
  if (!file) { process.stderr.write("--file <task.yaml> required\n"); process.exit(2); }
  const input = parseTaskFile(file);
  const repo = openRepo();
  const t = repo.createTask(input);
  repo.close();
  process.stdout.write(`created task ${t.id}  status=${t.status}  priority=${t.priority}\n`);
  process.stdout.write(`project: ${t.projectPath}\n`);
  process.stdout.write(`goal: ${t.originalGoal.slice(0, 80)}${t.originalGoal.length > 80 ? "..." : ""}\n`);
  process.stdout.write("(daemon 将在下个 tick 或额度恢复后自动运行)\n");
}

function taskList(): void {
  const repo = openRepo();
  const tasks = repo.listTasks();
  if (!tasks.length) { process.stdout.write("(no tasks)\n"); repo.close(); return; }
  for (const t of tasks) process.stdout.write(fmtTaskLine(t) + "\n");
  repo.close();
}

function taskShow(opts: Record<string, string>): void {
  const id = opts["id"];
  if (!id) { process.stderr.write("--id <taskId> required\n"); process.exit(2); }
  const repo = openRepo();
  const t = repo.getTask(id);
  repo.close();
  if (!t) { process.stderr.write("task not found\n"); process.exit(3); }
  process.stdout.write(JSON.stringify(t, null, 2) + "\n");
}

function taskState(opts: Record<string, string>, to: ManagedTask["status"]): void {
  const id = opts["id"];
  if (!id) { process.stderr.write("--id <taskId> required\n"); process.exit(2); }
  const repo = openRepo();
  const t = repo.getTask(id);
  if (!t) { repo.close(); process.stderr.write("task not found\n"); process.exit(3); }
  if (TERMINAL_STATUSES.has(t.status) && to !== "CANCELLED") {
    repo.close(); process.stderr.write(`task is terminal (${t.status}); cannot change\n`); process.exit(3);
  }
  repo.forceStatus(id, to);
  if (to === "READY") repo.patch(id, { nextRunAt: Date.now() });
  repo.close();
  process.stdout.write(`task ${id} -> ${to}\n`);
}

function taskRunNow(opts: Record<string, string>): void {
  const id = opts["id"];
  if (!id) { process.stderr.write("--id <taskId> required\n"); process.exit(2); }
  const repo = openRepo();
  const t = repo.getTask(id);
  if (!t) { repo.close(); process.stderr.write("task not found\n"); process.exit(3); }
  repo.forceStatus(id, "READY");
  repo.patch(id, { nextRunAt: Date.now() });
  repo.close();
  process.stdout.write(`task ${id} -> READY (daemon 下个 tick 运行)\n`);
}

function cmdDaemon(sub: string | undefined): void {
  if (sub === "install-autostart" || sub === "remove-autostart") {
    process.stdout.write(`daemon ${sub}: 占位 — 请使用 Windows 任务计划程序在用户登录时启动 car-daemon\n`);
    return;
  }
  process.stdout.write(`daemon ${sub ?? "(none)"}: 管理请运行 pnpm --filter @car/daemon start\n`);
}

/* ------------------------------ helpers ------------------------------ */

function fmtTaskLine(t: ManagedTask): string {
  const thread = t.threadId ? t.threadId.slice(0, 8) : "-";
  return `  ${t.id}  [${t.status.padEnd(14)}]  p=${String(t.priority).padStart(3)}  th=${thread}  cycles=${t.runCycleCount}/${t.maxRunCycles}  qCycles=${t.quotaCycleCount}/${t.maxQuotaCycles}  ${t.title}`;
}

function fmtUntil(ts: number): string {
  const ms = ts - Date.now();
  if (ms <= 0) return "now";
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}h${m}m`;
  if (m > 0) return `${m}m${s % 60}s`;
  return `${s}s`;
}

/** 极简 YAML 解析（只支持本项目 task.yaml 的子集字段） */
function parseTaskFile(file: string): CreateTaskInput {
  const raw = readFileSync(file, "utf8");
  const get = (key: string): string | undefined => {
    const m = raw.match(new RegExp(`^${key}:\\s*(.+)$`, "m"));
    return m?.[1]?.trim().replace(/^["']|["']$/g, "");
  };
  const getBlock = (key: string): string => {
    const m = raw.match(new RegExp(`^${key}:\\s*\\|\\s*\\n([\\s\\S]*?)(?=^\\S|\\Z)`, "m"));
    return m?.[1]?.trim() ?? "";
  };
  const getList = (key: string): string[] => {
    const m = raw.match(new RegExp(`^${key}:\\s*\\n((?:\\s+-\\s.*\\n?)+)`, "m"));
    if (!m) return [];
    return (m[1] ?? "").split("\n").map((l) => l.replace(/^\s+-\s/, "").trim().replace(/^["']|["']$/g, "")).filter(Boolean);
  };
  return {
    title: get("title") ?? "untitled",
    projectPath: get("projectPath") ?? process.cwd(),
    originalGoal: getBlock("goal") || get("goal") || "",
    acceptanceCriteria: getList("acceptanceCriteria"),
    priority: num(get("priority"), 50),
    mode: (get("mode") as CreateTaskInput["mode"]) ?? "new_thread",
    threadId: get("threadId") ?? null,
    model: get("model") ?? null,
    sandboxMode: get("sandboxMode") === "readOnly" ? "readOnly" : "workspaceWrite",
    networkAccess: get("networkAccess") === "true",
    approvalMode: get("approvalMode") === "interactive" ? "interactive" : "safe_autonomous",
    workspaceMode: get("workspaceMode") === "worktree" ? "worktree" : "direct",
    validationCommands: parseValidationCommands(raw),
    maxRunCycles: num(get("maxRunCycles"), 5),
    maxQuotaCycles: num(get("maxQuotaCycles"), 10),
    maxRetryCount: num(get("maxRetryCount"), 3),
  };
}

function parseValidationCommands(raw: string): CreateTaskInput["validationCommands"] {
  const m = raw.match(/validationCommands:\s*\n((?:\s+-.*\n?)+)/);
  if (!m) return [];
  const lines = (m[1] ?? "").split("\n").filter((l) => l.trim().startsWith("-"));
  return lines.map((l, i) => {
    const cmd = l.replace(/^\s+-\s*/, "").trim().replace(/^["']|["']$/g, "");
    return { id: `val${i}`, command: cmd, required: true, timeoutMs: 600_000 };
  });
}

function num(s: string | undefined, def: number): number {
  if (!s) return def;
  const n = Number(s);
  return Number.isFinite(n) ? n : def;
}

main().catch((e) => {
  process.stderr.write("car error: " + (e?.stack ?? String(e)) + "\n");
  process.exit(1);
});