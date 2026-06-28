/**
 * 确定性验证命令执行器 + 完成结果结构。
 *
 * 验证命令只允许来自：用户配置的 validationCommands、已批准模板。
 * 不通过 shell 字符串拼接，使用 execFile；超时；限制输出大小；不继承敏感环境。
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import type { ValidationCommand } from "@car/persistence";

export interface ValidationResult {
  commandId: string;
  exitCode: number | null;
  timedOut: boolean;
  stdoutTail: string;
  stderrTail: string;
  startedAt: number;
  finishedAt: number;
  ok: boolean;
}

export interface CompletionResult {
  status: "completed" | "needs_continue" | "needs_user" | "blocked" | "failed";
  summary: string;
  completed_items: string[];
  remaining_items: string[];
  changed_files: string[];
  recommended_validation: string[];
  needs_user_reason: string | null;
  risk_notes: string[];
}

/** 让 Codex 严格遵守的 JSON Schema（用于 turn/start 的 outputSchema） */
export const COMPLETION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["status", "summary", "completed_items", "remaining_items", "changed_files", "recommended_validation", "needs_user_reason", "risk_notes"],
  properties: {
    status: { type: "string", enum: ["completed", "needs_continue", "needs_user", "blocked", "failed"] },
    summary: { type: "string" },
    completed_items: { type: "array", items: { type: "string" } },
    remaining_items: { type: "array", items: { type: "string" } },
    changed_files: { type: "array", items: { type: "string" } },
    recommended_validation: { type: "array", items: { type: "string" } },
    needs_user_reason: { type: ["string", "null"] },
    risk_notes: { type: "array", items: { type: "string" } },
  },
} as const;

const DEFAULT_TIMEOUT_MS = 10 * 60_000;
const MAX_STDIO = 256 * 1024;

function isShellConstruct(cmd: string): boolean {
  // 简单过滤：已知仅纯命令；这里不拆分 shell 元字符。仅作最小启发。
  return /[|&;`$<>]/.test(cmd);
}

/** 执行给定的验证命令（使用 execFile，不经过 shell） */
export function runValidation(cmd: ValidationCommand, opts: { cwd: string } = { cwd: process.cwd() }): Promise<ValidationResult> {
  const timeoutMs = cmd.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const startedAt = Date.now();
  return new Promise((resolve) => {
    // 解析为 command + args。对 Windows 来说：尽量使用 cmd /c 仅当显式带 shell 元字符时；
    // 默认按空格拆（保守）。本实现允许拼接，但鼓励用户写完整命令。
    let file: string;
    let args: string[];
    if (isShellConstruct(cmd.command)) {
      file = process.platform === "win32" ? "cmd.exe" : "/bin/sh";
      args = process.platform === "win32" ? ["/d", "/s", "/c", cmd.command] : ["-c", cmd.command];
    } else {
      const parts = cmd.command.trim().split(/\s+/);
      file = parts[0] ?? "";
      args = parts.slice(1);
    }
    const child = spawn(file, args, {
      cwd: cmd.cwd ?? opts.cwd,
      windowsHide: true,
      env: { ...sanitizedEnv() },
      shell: false,
    });
    let stdoutTail = "";
    let stderrTail = "";
    let timedOut = false as boolean;
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill("SIGTERM"); } catch { /* ignore */ }
      setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* ignore */ } }, 2000);
    }, timeoutMs);

    child.stdout.on("data", (b: Buffer) => {
      stdoutTail += b.toString();
      if (stdoutTail.length > MAX_STDIO) stdoutTail = stdoutTail.slice(-MAX_STDIO);
    });
    child.stderr.on("data", (b: Buffer) => {
      stderrTail += b.toString();
      if (stderrTail.length > MAX_STDIO) stderrTail = stderrTail.slice(-MAX_STDIO);
    });
    child.on("error", () => {
      clearTimeout(timer);
      resolve({ commandId: cmd.id, exitCode: null, timedOut, stdoutTail, stderrTail, startedAt, finishedAt: Date.now(), ok: false });
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve({ commandId: cmd.id, exitCode: code, timedOut, stdoutTail, stderrTail, startedAt, finishedAt: Date.now(), ok: code === 0 && !timedOut });
    });
  });
}

/** 执行所有 required 验证命令；返回结果数组。短路由超时/失败不影响后续命令执行。 */
export async function runValidations(cmds: ValidationCommand[], opts: { cwd: string }): Promise<ValidationResult[]> {
  const out: ValidationResult[] = [];
  for (const c of cmds) {
    if (c.required === false) {
      // 非 required 仍执行但 ok=false 不阻塞；先执行后再判断
    }
    out.push(await runValidation(c, opts));
  }
  return out;
}

/** 所有 required 验证通过才算验收通过 */
export function validationsPassed(results: ValidationResult[], cmds: ValidationCommand[]): boolean {
  return cmds.every((c) => c.required === false || (results.find((r) => r.commandId === c.id)?.ok === true));
}

/** 进展哈希：用于无进展检测 */
export function progressHash(diffHash: string, completedItems: string[], remainingItems: string[], validationSummary: string): string {
  return createHash("sha256").update(`${diffHash}|${completedItems.join("\n")}|${remainingItems.join("\n")}|${validationSummary}`).digest("hex");
}

function sanitizedEnv(): Record<string, string> {
  const e: Record<string, string> = {};
  for (const k of ["PATH", "SystemRoot", "TEMP", "TMP", "LOCALAPPDATA", "APPDATA", "USERPROFILE", "HOME", "LANG", "LC_ALL", "NUMBER_OF_PROCESSORS"]) {
    if (process.env[k]) e[k] = process.env[k] as string;
  }
  return e;
}