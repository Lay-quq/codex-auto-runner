/**
 * Codex 可执行文件解析器。
 *
 * 背景：Codex 桌面版（MSIX）把 codex.exe 放在
 *   C:\Program Files\WindowsApps\OpenAI.Codex_*\app\resources\codex.exe
 * 该目录受 ACL 保护，直接调用会 "Access is denied"，且没有注册执行别名。
 * 解决：探测目标二进制后，将其连同 `codex` 等依赖目录整体拷贝到用户可写暂存区，
 *   后续统一从暂存区运行。也支持用户通过 CAR_CODEX_EXEC 显式指定。
 */

import { existsSync, copyFileSync, mkdirSync, cpSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import type { Logger } from "@car/logger";

export interface CodexResolveResult {
  path: string;
  version: string | null;
  source: "env" | "path" | "staged" | "windowsapps";
  staged: boolean;
}

const ENV_VAR = "CAR_CODEX_EXEC";

/**
 * 用 PowerShell Get-AppxPackage 免提权探测 Codex 桌面版安装路径。
 * 直接 readdirSync("C:\Program Files\WindowsApps") 会被 ACL 拒绝（需提权）。
 */
function candidateWindowsAppsCodex(): string | null {
  const ps = `
    $ErrorActionPreference='SilentlyContinue';
    $p = Get-AppxPackage -Name 'OpenAI.Codex' | Sort-Object -Property Version -Descending | Select-Object -First 1;
    if ($p) { Join-Path $p.InstallLocation 'app\\resources\\codex.exe' }
  `;
  try {
    const r = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", ps], {
      windowsHide: true,
      encoding: "utf8",
      timeout: 15_000,
    });
    if (r.status === 0 && r.stdout) {
      const path = r.stdout.trim();
      if (path && existsSync(path)) return path;
    }
  } catch {
    /* ignore */
  }
  return null;
}

function tryVersion(p: string): string | null {
  try {
    const r = spawnSync(p, ["--version"], { windowsHide: true, encoding: "utf8", timeout: 10_000 });
    if (r.status === 0 && r.stdout) {
      const m = r.stdout.match(/[\d]+\.[\d]+\.[\d]+/);
      return m ? m[0] : r.stdout.trim();
    }
  } catch {
    /* ignore */
  }
  return null;
}

/** 默认暂存目录：%LOCALAPPDATA%\CodexAutoRunner\codex-portable\codex.exe */
export function defaultStagingDir(): string {
  const local = process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local");
  return join(local, "CodexAutoRunner", "codex-portable");
}

/**
 * 解析 codex 可执行路径。
 *
 * 优先级：
 *   1. env CAR_CODEX_EXEC（若可运行，直接用）
 *   2. 已有暂存副本（若可运行，直接用）
 *   3. PATH 中的 codex
 *   4. WindowsApps 内置 codex.exe —— 拷贝到暂存区后使用
 */
export async function resolveCodex(log?: Logger): Promise<CodexResolveResult> {
  const stagedPre = join(defaultStagingDir(), "codex.exe");

  // 1. env
  const envPath = process.env[ENV_VAR];
  if (envPath && existsSync(envPath)) {
    const v = tryVersion(envPath);
    if (v) {
      log?.info("codex resolved from env", { path: envPath, version: v });
      return { path: envPath, version: v, source: "env", staged: false };
    }
    log?.warn("env CAR_CODEX_EXEC set but not runnable", { path: envPath });
  }

  // 2. existing staging
  if (existsSync(stagedPre)) {
    const v = tryVersion(stagedPre);
    if (v) {
      log?.info("codex resolved from staging", { path: stagedPre, version: v });
      return { path: stagedPre, version: v, source: "staged", staged: true };
    }
    log?.warn("staged codex exists but not runnable, will re-stage", { path: stagedPre });
  }

  // 3. PATH
  const pathExe = which("codex");
  if (pathExe) {
    const v = tryVersion(pathExe);
    if (v) {
      log?.info("codex resolved from PATH", { path: pathExe, version: v });
      return { path: pathExe, version: v, source: "path", staged: false };
    }
  }

  // 4. WindowsApps bundled -> stage
  const src = candidateWindowsAppsCodex();
  if (!src) {
    throw new Error(
      "Codex 未找到。请安装 Codex 桌面版/CLI，或通过环境变量 " + ENV_VAR + " 指定 codex 可执行路径。"
    );
  }
  log?.info("staging codex from WindowsApps", { src, dest: defaultStagingDir() });
  mkdirSync(defaultStagingDir(), { recursive: true });
  copyFileSync(src, stagedPre);
  // 拷贝可能被 codex 运行时需要的同级目录
  const srcDir = join(src, "..");
  for (const sub of ["codex", "codex-command-runner.exe", "plugins", "cua_node"]) {
    const from = join(srcDir, sub);
    if (existsSync(from)) {
      const to = join(defaultStagingDir(), sub);
      try { cpSync(from, to, { recursive: true }); } catch { /* ignore */ }
    }
  }
  const v = tryVersion(stagedPre);
  if (!v) {
    throw new Error("从 WindowsApps 暂存 codex 后仍无法运行，请检查 Codex 安装完整性。");
  }
  log?.info("codex staged ok", { path: stagedPre, version: v });
  return { path: stagedPre, version: v, source: "windowsapps", staged: true };
}

function which(cmd: string): string | null {
  const exts = (process.env.PATHEXT ?? ".EXE").split(";").map((e) => e.toUpperCase());
  const dirs = (process.env.PATH ?? "").split(";").filter(Boolean);
  for (const d of dirs) {
    try {
      for (const e of exts) {
        const p = join(d, cmd + (cmd.toLowerCase().endsWith(e.toLowerCase()) ? "" : e));
        if (existsSync(p)) return p;
      }
    } catch { /* ignore */ }
  }
  return null;
}