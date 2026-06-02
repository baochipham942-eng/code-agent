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
 * Token 来源标签 — 按产品维度（不是消息结构维度）拆分上下文占用
 * 用于回答"哪个 skill / MCP / subagent 在烧 token"，配合 SkillsPanel 做卸载决策
 */
export type SourceTag =
  | { type: 'rule'; name: string }
  | { type: 'skill'; name: string }
  | { type: 'mcp'; server: string }
  | { type: 'subagent'; name: string }
  | { type: 'fileRead' }
  | { type: 'conversation' };

/**
 * 按产品来源拆分的 token 占用
 * 与 TokenBreakdown 的 systemPrompt/messages/toolResults（消息结构维度）正交
 * conversation 字段用扣减法：messages 总数 - 其他 source 之和
 */
export interface SourceBreakdown {
  rules: number;
  skills: Record<string, number>;
  mcp: Record<string, number>;
  subagents: Record<string, number>;
  fileReads: number;
  conversation: number;
}

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
  /** 工具 schema 定义占用的 tokens（每轮请求都会发，之前漏算导致 UI 显示偏低） */
  toolDefinitions?: number;
  /**
   * 按产品来源拆分（可选，老 session 无此字段时 UI 不渲染二级展开）
   * 与上面 4 个字段是不同维度的拆分（消息结构 vs 产品来源）
   */
  bySource?: SourceBreakdown;
}

/**
 * 创建空的 SourceBreakdown
 */
export function createEmptySourceBreakdown(): SourceBreakdown {
  return {
    rules: 0,
    skills: {},
    mcp: {},
    subagents: {},
    fileReads: 0,
    conversation: 0,
  };
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

export interface ContextCompressionConfig {
  /** 自动压缩是否开启 */
  enabled: boolean;
  /** 达到该使用率后开始提醒或准备压缩，0-1 */
  warningThreshold: number;
  /** 达到该使用率后主动压缩，0-1 */
  criticalThreshold: number;
  /** 压缩后保留最近消息数 */
  preserveRecentCount: number;
  /** 绝对 token 数触发阈值 */
  triggerTokens?: number;
  /** 压缩摘要 provider */
  compactProvider?: string;
  /** 压缩摘要模型 */
  compactModel?: string;
  /** 是否记录压缩审计快照 */
  auditEnabled: boolean;
}

export interface ContextCompressionChannelState {
  config: ContextCompressionConfig;
  runtime: {
    compressionCount: number;
    totalSavedTokens: number;
    lastCompressionAt?: number;
    recentStrategies: string[];
  };
  compactModel: {
    provider?: string;
    model?: string;
    configured: boolean;
  };
  features: {
    audit: 'enabled' | 'disabled';
    manifest: 'enabled';
    hooks: 'available';
  };
}

export type ContextCompressionConfigPatch = Partial<ContextCompressionConfig>;

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
  /**
   * GAP-023: 被 system prompt 预算丢弃/裁剪的注入块标签（如 'deferred tools' / 'skills'）。
   * 用于 context health 面板可见化——agent 能力缩水时用户能看到原因，不再静默。
   */
  droppedPromptBlocks?: string[];
}

/**
 * 手动 Compact 操作的结构化返回
 */
export interface CompactResult {
  success: boolean;
  /** 失败或弱成功时给 UI/日志展示的原因 */
  reason?: string;
  /** 压缩前 token 数 */
  beforeTokens: number;
  /** 压缩后 token 数 */
  afterTokens: number;
  /** 本次释放的 token 数 */
  savedTokens: number;
  /** 压缩前使用率 */
  beforePercent: number;
  /** 压缩后使用率 */
  afterPercent: number;
  /** 使用的压缩层 */
  layersUsed: string[];
  /** 保留策略 */
  retained: {
    /** 保留的最近对话轮数 */
    recentTurns: number;
    /** 用户手动 pin 的项数 */
    pinnedItems: number;
  };
  /** 本会话累计压缩次数 */
  compressionCount: number;
  /** 本会话累计释放 token 数 */
  totalSavedTokens: number;
  /** 新生成的摘要消息 ID */
  summaryMessageId?: string;
  /** 被压缩的消息数 */
  compactedMessageCount?: number;
  /** 保留的消息数 */
  preservedMessageCount?: number;
  /** 实际执行摘要的 provider */
  provider?: string;
  /** 实际执行摘要的 model */
  model?: string;
  /** 压缩质量或校验警告 */
  warnings?: string[];
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
      bySource: createEmptySourceBreakdown(),
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
