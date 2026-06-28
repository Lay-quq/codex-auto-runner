/**
 * Codex Auto Runner — 共享类型定义
 *
 * 仅存放与具体实现无关的核心领域类型：配置、额度模型、认证模式、状态枚举。
 * 协议级类型见 @car/protocol-schema；数据库类型见 @car/persistence。
 */

/** 认证模式 */
export type AuthMode = "chatgpt" | "apiKey" | "none" | "unknown";

/** 额度状态 */
export type QuotaStatus =
  | "available"
  | "near_limit"
  | "exhausted"
  | "auth_required"
  | "unknown";

/** 全局运行配置（持久化于 settings 表 / config 文件） */
export interface RunnerConfig {
  app: {
    autoRunEnabled: boolean;
    maxConcurrentTasks: number;
    logRetentionDays: number;
  };
  codex: {
    /** codex 可执行文件绝对路径；"auto" 表示自动探测 */
    executablePath: string;
    requireCompatibleSchema: boolean;
  };
  quota: {
    nearLimitPercent: number;
    safetyBufferSeconds: number;
    jitterMinSeconds: number;
    jitterMaxSeconds: number;
    availablePollMinutes: number;
    nearLimitPollMinutes: number;
    exhaustedPollFallbackMinutes: number;
  };
}

/** 默认配置（与文档第 34 节一致） */
export const DEFAULT_CONFIG: RunnerConfig = {
  app: {
    autoRunEnabled: true,
    maxConcurrentTasks: 1,
    logRetentionDays: 30,
  },
  codex: {
    executablePath: "auto",
    requireCompatibleSchema: true,
  },
  quota: {
    nearLimitPercent: 90,
    safetyBufferSeconds: 30,
    jitterMinSeconds: 15,
    jitterMaxSeconds: 45,
    availablePollMinutes: 10,
    nearLimitPollMinutes: 2,
    exhaustedPollFallbackMinutes: 15,
  },
};