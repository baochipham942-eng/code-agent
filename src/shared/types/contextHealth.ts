// ============================================================================
// Context Health Types - 上下文健康状态类型定义
// ============================================================================

/**
 * 上下文健康警告级别
 * - normal: < 70% 使用率
 * - warning: 70-85% 使用率
 * - critical: > 85% 使用率
 */
export type ContextHealthWarningLevel = 'normal' | 'warning' | 'critical';

/**
 * Token 使用分解
 */
export interface TokenBreakdown {
  /** System Prompt 占用的 tokens */
  systemPrompt: number;
  /** 消息历史占用的 tokens */
  messages: number;
  /** 工具结果占用的 tokens */
  toolResults: number;
}

/**
 * 压缩状态
 * - none: 未触发压缩
 * - warning: 接近阈值，准备压缩
 * - active: 正在压缩
 * - critical: 紧急压缩
 */
export type CompressionStatus = 'none' | 'warning' | 'active' | 'critical';

/**
 * 压缩统计信息
 */
export interface CompressionStats {
  /** 压缩状态 */
  status: CompressionStatus;
  /** 上次压缩时间戳 */
  lastCompressionAt?: number;
  /** 本会话压缩次数 */
  compressionCount: number;
  /** 累计节省的 tokens */
  totalSavedTokens: number;
}

/**
 * 上下文健康状态
 */
export interface ContextHealthState {
  /** 当前使用的 tokens */
  currentTokens: number;
  /** 单会话最大 tokens */
  maxTokens: number;
  /** 使用百分比 (0-100) */
  usagePercent: number;
  /** Token 使用分解 */
  breakdown: TokenBreakdown;
  /** 警告级别 */
  warningLevel: ContextHealthWarningLevel;
  /** 预估剩余对话轮数 */
  estimatedTurnsRemaining: number;
  /** 最后更新时间戳 */
  lastUpdated: number;
  /** 压缩统计 */
  compression?: CompressionStats;
}

/**
 * 上下文健康更新事件
 */
export interface ContextHealthUpdateEvent {
  sessionId: string;
  health: ContextHealthState;
}

/**
 * 计算警告级别
 */
export function getWarningLevel(usagePercent: number): ContextHealthWarningLevel {
  if (usagePercent >= 85) return 'critical';
  if (usagePercent >= 70) return 'warning';
  return 'normal';
}

/**
 * 创建空的健康状态
 */
export function createEmptyHealthState(maxTokens: number = 128000): ContextHealthState {
  return {
    currentTokens: 0,
    maxTokens,
    usagePercent: 0,
    breakdown: {
      systemPrompt: 0,
      messages: 0,
      toolResults: 0,
    },
    warningLevel: 'normal',
    estimatedTurnsRemaining: 0,
    lastUpdated: Date.now(),
    compression: {
      status: 'none',
      compressionCount: 0,
      totalSavedTokens: 0,
    },
  };
}

/**
 * 根据使用率计算压缩状态
 */
export function getCompressionStatus(usagePercent: number): CompressionStatus {
  if (usagePercent >= 90) return 'critical';
  if (usagePercent >= 85) return 'active';
  if (usagePercent >= 70) return 'warning';
  return 'none';
}
