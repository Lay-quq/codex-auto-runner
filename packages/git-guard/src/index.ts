/**
 * Git 工作区守卫：仓库检测、脏工作区、冲突、暂停期变化检测。
 *
 * 实测 codex.exe 0.142.3 需从暂存副本运行，依赖系统 git。本包只用 git CLI。
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

export interface GitState {
  isRepo: boolean;
  head: string | null;
  branch: string | null;
  porcelain: string[];
  gitDir: string | null;
  inMerge: boolean;
  inRebase: boolean;
  inCherryPick: boolean;
  hasConflicts: boolean;
}

export function runGit(args: string[], cwd: string): { status: number; stdout: string; stderr: string } {
  const r = spawnSync("git", args, { cwd, windowsHide: true, encoding: "utf8", timeout: 30_000 });
  return { status: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

export function inspect(cwd: string): GitState {
  const st = runGit(["rev-parse", "--is-inside-work-tree"], cwd);
  const isRepo = st.status === 0 && st.stdout.trim() === "true";
  if (!isRepo) {
    return { isRepo: false, head: null, branch: null, porcelain: [], gitDir: null, inMerge: false, inRebase: false, inCherryPick: false, hasConflicts: false };
  }
  const head = runGit(["rev-parse", "HEAD"], cwd).stdout.trim() || null;
  const branch = runGit(["branch", "--show-current"], cwd).stdout.trim() || null;
  const porcelain = runGit(["status", "--porcelain=v1"], cwd).stdout.split(/\r?\n/).filter(Boolean);
  const gitDir = runGit(["rev-parse", "--git-dir"], cwd).stdout.trim() || null;
  const inMerge = gitDir ? existsSync(`${gitDir}/MERGE_HEAD`) : false;
  const inRebase = gitDir ? existsSync(`${gitDir}/rebase-merge`) || existsSync(`${gitDir}/rebase-apply`) : false;
  const inCherryPick = gitDir ? existsSync(`${gitDir}/CHERRY_PICK_HEAD`) : false;
  const hasConflicts = porcelain.some((l) => /^(?:DD|AU|UD|UA|DU|AA|DU|UH|HU)/.test(l.trim().slice(0, 2)) || /\b(U{2}|U2)\b/.test(l));
  return { isRepo, head, branch, porcelain, gitDir, inMerge, inRebase, inCherryPick, hasConflicts };
}

export interface PrepareResult {
  ok: boolean;
  reason?: string;
  state: GitState;
}

/** 是否允许在此目录启动任务 */
export function prepareForRun(cwd: string, opts: { allowDirty?: boolean } = {}): PrepareResult {
  const state = inspect(cwd);
  if (!state.isRepo) {
    return { ok: true, state, reason: "not-a-repo（codex 仍可在此创建/写文件）" };
  }
  if (state.inMerge || state.inRebase || state.inCherryPick) {
    return { ok: false, state, reason: "git 中存在未完成的 merge/rebase/cherry-pick" };
  }
  if (state.hasConflicts) {
    return { ok: false, state, reason: "git 存在未解决冲突" };
  }
  if (state.porcelain.length > 0 && !opts.allowDirty) {
    return { ok: false, state, reason: "工作区不干净；需要显式授权" };
  }
  return { ok: true, state };
}

/** 暂停期间用户修改检测 */
export interface PauseChange {
  changed: boolean;
  headBefore: string | null;
  headAfter: string | null;
  diffBefore: string | null;
  diffAfter: string | null;
}

export function detectPauseChange(before: { head: string | null; diffHash: string | null }): PauseChange {
  const after = inspect(process.cwd());
  // 计算 diff 哈希（基于 porcelain）
  const diffAfter = after.porcelain.join("\n") + "|" + (after.head ?? "");
  const changed =
    (before.head != null && after.head != null && before.head !== after.head) ||
    (before.diffHash != null && before.diffHash !== diffAfter) ||
    (before.head == null && after.head != null);
  return { changed, headBefore: before.head, headAfter: after.head, diffBefore: before.diffHash, diffAfter };
}

/** 工作区 diff 哈希（用于暂停前后比较） */
export function diffHashOf(state: GitState): string {
  return state.porcelain.join("\n") + "|" + (state.head ?? "");
}