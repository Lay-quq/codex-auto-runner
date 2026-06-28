/**
 * 单实例锁：文件锁。位于应用数据目录。
 * 简化版：创建独占文件写入 pid；启动时若存在且 pid 存活则拒绝。
 * （生产可再加 Named Pipe 唯一名 + SQLite runtime_instance 租约，见文档 ADR-003）
 */

import { openSync, writeSync, closeSync, unlinkSync, existsSync, readFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";

export function defaultDataDir(): string {
  const local = process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local");
  return join(local, "CodexAutoRunner", "data");
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export class InstanceLock {
  private fd: number | null = null;
  private readonly path: string;
  constructor(dir = defaultDataDir()) {
    this.path = join(dir, "daemon.lock");
  }
  acquire(): { ok: boolean; reason?: string } {
    mkdirSync(dirname(this.path), { recursive: true });
    if (existsSync(this.path)) {
      try {
        const pid = Number.parseInt(readFileSync(this.path, "utf8").trim(), 10);
        if (Number.isFinite(pid) && pidAlive(pid) && pid !== process.pid) {
          return { ok: false, reason: `another daemon running (pid=${pid})` };
        }
        unlinkSync(this.path);
      } catch {
        /* stale lock, ignore */
      }
    }
    this.fd = openSync(this.path, "w");
    writeSync(this.fd, String(process.pid));
    return { ok: true };
  }
  release(): void {
    if (this.fd != null) {
      try { closeSync(this.fd); } catch { /* ignore */ }
      try { unlinkSync(this.path); } catch { /* ignore */ }
      this.fd = null;
    }
  }
}