/**
 * 极简结构化日志：JSON 行，级别过滤，敏感字段脱敏。
 * 避免早期引入原生依赖。可在后续替换为 Pino 而不改调用点。
 */

export type LogLevel = "trace" | "debug" | "info" | "warn" | "error" | "fatal";

const LEVEL_ORDER: Record<LogLevel, number> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
};

/** 需要脱敏的字段名（子串匹配，大小写不敏感） */
const SENSITIVE_KEYS = [
  "token",
  "apikey",
  "api_key",
  "authorization",
  "secret",
  "password",
  "credential",
  "auth.json",
  "email",
  "account_id",
];

function redact(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map((v) => redact(v));
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const lk = k.toLowerCase();
      if (SENSITIVE_KEYS.some((s) => lk.includes(s))) {
        out[k] = v == null ? v : "[REDACTED]";
      } else {
        out[k] = redact(v);
      }
    }
    return out;
  }
  return value;
}

export interface Logger {
  level: LogLevel;
  child(bindings: Record<string, unknown>): Logger;
  trace(msg: string, fields?: Record<string, unknown>): void;
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  fatal(msg: string, fields?: Record<string, unknown>): void;
}

export interface LoggerOptions {
  level?: LogLevel;
  /** 输出目标；默认 stderr（避免污染 stdio app-server 传输） */
  stream?: NodeJS.WritableStream;
  /** 静态绑定字段 */
  bindings?: Record<string, unknown>;
  /** 是否禁用脱敏（仅用于内部可信数据，默认 false） */
  disableRedaction?: boolean;
}

export function createLogger(opts: LoggerOptions = {}): Logger {
  const level: LogLevel = opts.level ?? "info";
  const stream = opts.stream ?? process.stderr;
  const baseBindings = opts.bindings ?? {};
  const doRedact = opts.disableRedaction !== true;

  function write(lvl: LogLevel, msg: string, fields?: Record<string, unknown>) {
    if (LEVEL_ORDER[lvl] < LEVEL_ORDER[level]) return;
    const rec = {
      time: Date.now(),
      level: lvl,
      msg,
      ...baseBindings,
      ...(fields ?? {}),
    };
    const safe = doRedact ? redact(rec) : rec;
    stream.write(JSON.stringify(safe) + "\n");
  }

  const logger: Logger = {
    level,
    child(bindings) {
      return createLogger({
        level,
        stream,
        bindings: { ...baseBindings, ...bindings },
        disableRedaction: opts.disableRedaction,
      });
    },
    trace(msg, f) { write("trace", msg, f); },
    debug(msg, f) { write("debug", msg, f); },
    info(msg, f) { write("info", msg, f); },
    warn(msg, f) { write("warn", msg, f); },
    error(msg, f) { write("error", msg, f); },
    fatal(msg, f) { write("fatal", msg, f); },
  };
  return logger;
}