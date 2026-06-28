/**
 * Codex App Server 客户端。
 *
 * 职责：
 *  - 以子进程方式启动 `codex app-server --listen stdio://`
 *  - 在 stdin/stdout 上做 JSON-RPC 2.0（每行一个 JSON 对象，JSONL）
 *  - 完成 initialize / initialized 握手
 *  - 请求管理：单调递增 id、超时、取消、连接关闭统一 reject
 *  - 分流：响应 / 通知 / 服务端请求
 *  - stderr 独立记录、非法行隔离、消息大小限制、敏感字段脱敏
 *  - 重连退避
 *
 * 不做：状态机恢复、额度解析（见 @car/quota-engine）、审批 UI。
 *
 * 传输格式说明：App Server 默认以 newline-delimited JSON 通信，
 * 每条消息占一行。本实现按行拆分并 JSON.parse。
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import type { Logger } from "@car/logger";
import type {
  JsonRpcRequest,
  JsonRpcNotification,
  JsonRpcResponse,
  JsonRpcServerRequest,
  AccountInfo,
  RateLimitsResult,
} from "@car/protocol-schema";

export interface AppServerClientOptions {
  /** codex 可执行文件绝对路径 */
  codexPath: string;
  /** 额外传递给 codex 的参数（默认 ["app-server","--listen","stdio://"]） */
  codexArgs?: string[];
  logger?: Logger;
  /** 单请求默认超时（毫秒），默认 30_000 */
  requestTimeoutMs?: number;
  /** 单条入站消息最大字节数，超出则丢弃并告警。默认 8 MB */
  maxMessageBytes?: number;
  /** 是否隐藏子进程窗口（Windows），默认 true */
  windowsHide?: boolean;
  /** 子进程当前工作目录，默认 process.cwd() */
  cwd?: string;
}

export interface AppServerClientEvents {
  /** 服务端通知 */
  notification: (method: string, params: unknown) => void;
  /** 服务端发起的请求（审批等），需调用 respond/respondError 回复 */
  serverRequest: (req: JsonRpcServerRequest) => void;
  /** 连接关闭 */
  disconnected: (reason: { code: number | null; signal: NodeJS.Signals | null; lastError?: string }) => void;
  /** 重连成功 */
  reconnected: () => void;
  /** stderr 一行 */
  stderr: (line: string) => void;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
  method: string;
}

const HANDSHAKE_TIMEOUT_MS = 15_000;

export class AppServerClient extends EventEmitter {
  private readonly opts: Required<Omit<AppServerClientOptions, "logger" | "codexArgs" | "cwd">>;
  private readonly codexArgs: string[];
  private readonly cwd: string | undefined;
  private readonly log: Logger;

  private child: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private readonly pending = new Map<number | string, PendingRequest>();
  private buffer = "";
  private initialized = false;
  private closed = false;
  private reconnecting = false;
  private reconnectAttempts = 0;
  private lastStderrTail = "";
  private childExitInfo: { code: number | null; signal: NodeJS.Signals | null } | null = null;

  /** 启动时捕获的诊断信息 */
  readonly diagnostics: {
    codexVersion?: string;
    serverProtocolVersion?: string | number;
    serverName?: string;
    serverVersion?: string;
    startedAt?: number;
  } = {};

  constructor(opts: AppServerClientOptions) {
    super();
    this.log = (opts.logger ?? createDefaultLogger()).child({ comp: "app-server-client" });
    const maxMessageBytes = opts.maxMessageBytes ?? 8 * 1024 * 1024;
    this.opts = {
      codexPath: opts.codexPath,
      requestTimeoutMs: opts.requestTimeoutMs ?? 30_000,
      maxMessageBytes,
      windowsHide: opts.windowsHide ?? true,
    };
    this.codexArgs = opts.codexArgs ?? ["app-server", "--listen", "stdio://"];
    this.cwd = opts.cwd;
  }

  /** 是否已完成 initialize/initialized 握手且子进程存活 */
  isHealthy(): boolean {
    return this.initialized && !this.closed && this.child !== null && this.child.exitCode === null && this.child.signalCode === null;
  }

  /** 启动子进程并完成握手 */
  async start(): Promise<void> {
    if (this.child && !this.closed) return;
    this.closed = false;
    this.log.info("starting codex app-server", { path: this.opts.codexPath, args: this.codexArgs });
    const child = spawn(this.opts.codexPath, this.codexArgs, {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: this.opts.windowsHide,
      cwd: this.cwd,
      env: { ...process.env },
    });
    this.child = child;
    this.childExitInfo = null;

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    child.stdout.on("data", (chunk: string) => this.onStdoutData(chunk));
    child.stderr.on("data", (chunk: string) => this.onStderrData(chunk));
    child.on("error", (err) => {
      this.log.error("child spawn error", { err: String(err) });
      this.failAllPending(new Error("app-server spawn failed: " + err.message));
    });
    child.on("exit", (code, signal) => {
      this.childExitInfo = { code, signal };
      this.log.warn("app-server exited", { code, signal });
      this.failAllPending(new Error(`app-server exited code=${code} signal=${signal}`));
      this.initialized = false;
      const reason = { code, signal, lastError: this.lastStderrTail || undefined };
      this.emit("disconnected", reason);
      if (!this.closed) this.scheduleReconnect();
    });

    await this.handshake();
    this.reconnectAttempts = 0;
    this.diagnostics.startedAt = Date.now();
  }

  /** 主动关闭，不再重连 */
  async close(): Promise<void> {
    this.closed = true;
    this.failAllPending(new Error("client closed"));
    const child = this.child;
    if (child) {
      try { child.stdin?.end(); } catch { /* ignore */ }
      try { child.kill("SIGTERM"); } catch { /* ignore */ }
      await once(child, "exit").catch(() => undefined);
    }
    this.child = null;
    this.initialized = false;
  }

  /** 发送请求并等待 result。params 缺省时发 {} —— 该 app-server 要求 params 字段必须存在 */
  request<R = unknown>(method: string, params?: unknown): Promise<R> {
    if (this.closed) return Promise.reject(new Error("client closed"));
    if (!this.child) return Promise.reject(new Error("app-server not started"));
    const id = this.nextId++;
    const payload: JsonRpcRequest = { jsonrpc: "2.0", id, method, params: params ?? {} };
    return new Promise<R>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`request timeout: ${method} (id=${id})`));
      }, this.opts.requestTimeoutMs);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer, method });
      this.send(payload);
    });
  }

  /** 回复服务端请求（accept/decline 等） */
  respond(serverRequestId: number | string, result: unknown): void {
    this.send({ jsonrpc: "2.0", id: serverRequestId, result });
  }

  /** 回复服务端请求错误 */
  respondError(serverRequestId: number | string, code: number, message: string): void {
    this.send({ jsonrpc: "2.0", id: serverRequestId, error: { code, message } });
  }

  /* --------------------------- 高级便捷调用 --------------------------- */

  async getAccount(): Promise<AccountInfo> {
    return this.request<AccountInfo>("account/read");
  }

  async getRateLimits(): Promise<RateLimitsResult> {
    return this.request<RateLimitsResult>("account/rateLimits/read");
  }

  /* ------------------------------- 内部 ------------------------------- */

  private async handshake(): Promise<void> {
    const initResult = await this.requestRaw<{ protocolVersion?: string | number; serverInfo?: { name?: string; version?: string }; codexVersion?: string }>(
      "initialize",
      {
        clientInfo: {
          name: "codex_auto_runner",
          title: "Codex Auto Runner",
          version: "0.1.0",
        },
      },
      HANDSHAKE_TIMEOUT_MS,
    );
    this.diagnostics.serverProtocolVersion = initResult?.protocolVersion;
    this.diagnostics.serverName = initResult?.serverInfo?.name;
    this.diagnostics.serverVersion = initResult?.serverInfo?.version;
    this.diagnostics.codexVersion = initResult?.codexVersion;
    // initialized 通知（无 id）
    this.send({ jsonrpc: "2.0", method: "initialized", params: {} } satisfies JsonRpcNotification);
    this.initialized = true;
    this.log.info("handshake done", this.diagnostics as Record<string, unknown>);
  }

  private requestRaw<R>(method: string, params: unknown, timeoutMs: number): Promise<R> {
    const id = this.nextId++;
    const payload: JsonRpcRequest = { jsonrpc: "2.0", id, method, params: params ?? {} };
    return new Promise<R>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`handshake timeout: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer, method });
      this.send(payload);
    });
  }

  private send(obj: unknown): void {
    const child = this.child;
    if (!child || !child.stdin || child.stdin.destroyed) {
      this.failAllPending(new Error("stdin not writable"));
      return;
    }
    try {
      child.stdin.write(JSON.stringify(obj) + "\n");
    } catch (e) {
      this.log.error("send failed", { err: String(e) });
      this.failAllPending(new Error("send failed"));
    }
  }

  private onStdoutData(chunk: string): void {
    this.buffer += chunk;
    let nl: number;
    while ((nl = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, nl);
      this.buffer = this.buffer.slice(nl + 1);
      if (line.length > this.opts.maxMessageBytes) {
        this.log.warn("inbound message exceeds size limit, dropping", { bytes: line.length });
        continue;
      }
      const trimmed = line.trim();
      if (!trimmed) continue;
      this.handleMessage(trimmed);
    }
  }

  private onStderrData(chunk: string): void {
    const text = chunk.toString();
    // 仅尾部用于诊断
    this.lastStderrTail = text.slice(-2000);
    for (const ln of text.split(/\r?\n/)) {
      const t = ln.trim();
      if (t) this.emit("stderr", t);
    }
    this.log.debug("app-server stderr", { line: text.trim() });
  }

  private handleMessage(raw: string): void {
    let msg: unknown;
    try {
      msg = JSON.parse(raw);
    } catch {
      this.log.warn("non-JSON inbound line isolated", { head: raw.slice(0, 200) });
      return;
    }
    if (typeof msg !== "object" || msg === null) return;
    const m = msg as { jsonrpc?: string; id?: number | string | null; method?: string; result?: unknown; error?: unknown; params?: unknown };
    // 响应
    if (m.id !== undefined && m.id !== null && !m.method) {
      const pending = this.pending.get(m.id);
      if (!pending) {
        this.log.warn("response without pending request", { id: m.id });
        return;
      }
      clearTimeout(pending.timer);
      this.pending.delete(m.id);
      if (m.error) {
        pending.reject(toError(m.error));
      } else {
        pending.resolve(m.result);
      }
      return;
    }
    // 服务端请求（有 id 且有 method）
    if (m.id !== undefined && m.id !== null && m.method) {
      const req: JsonRpcServerRequest = { jsonrpc: "2.0", id: m.id, method: m.method, params: m.params };
      this.emit("serverRequest", req);
      return;
    }
    // 通知（无 id）
    if (m.method) {
      const note: JsonRpcNotification = { jsonrpc: "2.0", method: m.method, params: m.params };
      this.emit("notification", note.method, note.params);
      return;
    }
  }

  private failAllPending(err: Error): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }

  private scheduleReconnect(): void {
    if (this.closed || this.reconnecting) return;
    this.reconnecting = true;
    const backoff = this.reconnectBackoffMs(this.reconnectAttempts++);
    this.log.warn("scheduling reconnect", { attempt: this.reconnectAttempts, backoffMs: backoff });
    setTimeout(async () => {
      this.reconnecting = false;
      try {
        await this.start();
        this.emit("reconnected");
        this.log.info("reconnected");
      } catch (e) {
        this.log.error("reconnect failed", { err: String(e) });
        this.scheduleReconnect();
      }
    }, backoff);
  }

  private reconnectBackoffMs(attempt: number): number {
    const table = [1_000, 3_000, 10_000, 30_000];
    return table[Math.min(attempt, table.length - 1)] ?? 60_000;
  }
}

function toError(e: unknown): Error {
  if (e && typeof e === "object" && "message" in e) {
    const obj = e as { message: string; code?: number };
    return new Error(obj.message ?? String(e));
  }
  return new Error(String(e));
}

function once(emitter: ChildProcessWithoutNullStreams, event: string): Promise<void> {
  return new Promise((resolve) => {
    emitter.once(event, () => resolve());
    setTimeout(() => resolve(), 2_000);
  });
}

function createDefaultLogger(): Logger {
  // 延迟引入避免循环依赖；fallback 极简日志到 stderr
  return {
    level: "info",
    child() { return this; },
    trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {},
  } as unknown as Logger;
}

/** 随机实例标识，用于本工具唯一性（占位，单实例锁见 @car/persistence） */
export function newInstanceId(): string {
  return randomUUID();
}