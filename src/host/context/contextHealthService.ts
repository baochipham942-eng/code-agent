// ============================================================================
// Context Health Service - 上下文健康状态管理服务
// ============================================================================

import { AppWindow } from '../platform';
import { IPC_CHANNELS } from '../../shared/ipc';
import { getContextWindow, DEFAULT_MODEL } from '../../shared/constants';
import {
  ContextHealthState,
  ContextHealthUpdateEvent,
  CompressionStats,
  getWarningLevel,
  createEmptyHealthState,
  TokenBreakdown,
  SourceBreakdown,
} from '../../shared/contract/contextHealth';
import { estimateTokens } from './tokenEstimator';
import {
  computeSourceBreakdown,
  compositionMessagesTokens,
  compositionToolResultsTokens,
  type CompositionMessage,
  type SourceCompositionHints,
} from './contextComposition';
import { createLogger } from '../services/infra/logger';
import { getSessionStateManager } from '../session/sessionStateManager';

/**
 * Extended message type for context health tracking
 * Supports tool messages and tool results from AgentLoop
 *
 * N-CTXCURRENT: 与构成算法输入同构（contextComposition.CompositionMessage），
 * toolResults 需带 toolCallId 才能按工具名归桶。
 */
export type ContextMessage = CompositionMessage;

const logger = createLogger('ContextHealthService');

// Context window sizes sourced from shared constants

/**
 * N-CTXTRUTH: provider 实报的本轮输入用量（inference.ts 记账点透传）。
 * 口径统一在 usageNormalization.ts：归一化后 inputTokens 一律「不含缓存」，
 * 所以上下文占用总量 = inputTokens + cacheReadTokens + cacheCreationTokens。
 */
export interface ProviderContextUsage {
  inputTokens: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
}

function scaleValue(value: number, scale: number): number {
  return Math.round(value * scale);
}

function scaleSourceBreakdown(bs: SourceBreakdown, scale: number): SourceBreakdown {
  const scaleRecord = (rec: Record<string, number>) =>
    Object.fromEntries(Object.entries(rec).map(([k, v]) => [k, scaleValue(v, scale)]));
  return {
    rules: scaleValue(bs.rules, scale),
    skills: scaleRecord(bs.skills),
    mcp: scaleRecord(bs.mcp),
    subagents: scaleRecord(bs.subagents),
    fileReads: scaleValue(bs.fileReads, scale),
    summary: scaleValue(bs.summary, scale),
    conversation: scaleValue(bs.conversation, scale),
  };
}

/** 等比缩放整个 breakdown（桶间比例不变），用于把本地估算桶贴合到 provider 真总量 */
function scaleTokenBreakdown(breakdown: TokenBreakdown, scale: number): TokenBreakdown {
  return {
    systemPrompt: scaleValue(breakdown.systemPrompt, scale),
    messages: scaleValue(breakdown.messages, scale),
    toolResults: scaleValue(breakdown.toolResults, scale),
    ...(breakdown.toolDefinitions !== undefined
      ? { toolDefinitions: scaleValue(breakdown.toolDefinitions, scale) }
      : {}),
    ...(breakdown.bySource ? { bySource: scaleSourceBreakdown(breakdown.bySource, scale) } : {}),
  };
}

// ----------------------------------------------------------------------------
// Context Health Service
// ----------------------------------------------------------------------------

/**
 * 上下文健康服务
 *
 * 负责跟踪和报告每个会话的上下文使用情况
 *
 * N-CTXCURRENT: bySource 是「当前态」构成——每轮 update() 用
 * computeSourceBreakdown 从当前消息列表 + systemPrompt + 当前挂载 skills 全量重算，
 * 不再保留运行时累计账（recordSourceContribution 系列已退役）。重启后走
 * resolveContextHealthForSession 重算路径，同源同算法，历史会话桶不归零。
 */
export class ContextHealthService {
  private sessionStates: Map<string, ContextHealthState> = new Map();
  private mainWindow: AppWindow | null = null;
  private averageUserMessageTokens: number = 200; // 用户消息平均 tokens
  private averageAssistantMessageTokens: number = 800; // 助手消息平均 tokens

  /**
   * 设置主窗口用于发送事件
   */
  setMainWindow(window: AppWindow | null): void {
    this.mainWindow = window;
  }

  /**
   * 获取指定模型的上下文限制
   */
  getModelContextLimit(model: string): number {
    return getContextWindow(model);
  }

  /**
   * 更新会话的上下文健康状态
   *
   * @param sessionId - 会话 ID
   * @param messages - 当前消息历史
   * @param systemPrompt - 系统提示词
   * @param model - 模型名称
   * @param providerUsage - N-CTXTRUTH: 本轮 provider 实报用量（inputTokens 不含缓存，
   *   真总量内部会加上 cacheRead/cacheCreation）。有真源时 currentTokens/usagePercent
   *   按真源算、breakdown 各桶等比缩放到真总量；缺省或总量为 0 时全走本地估算，
   *   tokenSource='estimated'。
   * @param sourceHints - N-CTXCURRENT: 当前态构成的带外输入（目前只有当前挂载
   *   skills 的 token 估算；rules/mcp/subagents/fileReads/summary 全部从
   *   messages + systemPrompt 重算）
   */
  update(
    sessionId: string,
    messages: ContextMessage[],
    systemPrompt: string,
    model: string = DEFAULT_MODEL,
    compression?: CompressionStats,
    toolDefinitionsTokens?: number,
    droppedPromptBlocks?: string[],
    providerUsage?: ProviderContextUsage,
    sourceHints?: SourceCompositionHints,
  ): ContextHealthState {
    const maxTokens = this.getModelContextLimit(model);
    const previousHealth = this.sessionStates.get(sessionId);

    // 计算各部分的 token 使用量
    const systemPromptTokens = estimateTokens(systemPrompt);
    const messagesTokens = compositionMessagesTokens(messages);
    const toolResultsTokens = compositionToolResultsTokens(messages);
    // 工具 schema 定义：每次请求都会发给模型（包含 name/description/inputSchema JSON）。
    // 优先用调用方显式传值，否则自动从工具 registry 估算（registry 不可用时回退 0）。
    const toolDefTokens = toolDefinitionsTokens ?? 0;

    // N-CTXCURRENT: bySource 当前态快照——每轮全量重算，与上轮状态无关
    const bySource = computeSourceBreakdown(messages, systemPrompt, sourceHints);

    const estimatedBreakdown: TokenBreakdown = {
      systemPrompt: systemPromptTokens,
      messages: messagesTokens,
      toolResults: toolResultsTokens,
      toolDefinitions: toolDefTokens,
      bySource,
    };
    const estimatedTotal = systemPromptTokens + messagesTokens + toolResultsTokens + toolDefTokens;

    // N-CTXTRUTH: provider 实报总量（含缓存读/写）作真源；本地估算只决定桶内比例
    const providerTotal = providerUsage
      ? providerUsage.inputTokens +
        (providerUsage.cacheReadTokens ?? 0) +
        (providerUsage.cacheCreationTokens ?? 0)
      : 0;
    const useProviderTruth = providerTotal > 0;

    const currentTokens = useProviderTruth ? providerTotal : estimatedTotal;
    const breakdown: TokenBreakdown =
      useProviderTruth && estimatedTotal > 0
        ? scaleTokenBreakdown(estimatedBreakdown, providerTotal / estimatedTotal)
        : estimatedBreakdown;
    const usagePercent = Math.round((currentTokens / maxTokens) * 1000) / 10; // 保留一位小数

    // 计算预估剩余轮数
    const tokensPerTurn = this.averageUserMessageTokens + this.averageAssistantMessageTokens;
    const remainingTokens = maxTokens - currentTokens;
    const estimatedTurnsRemaining = Math.max(0, Math.floor(remainingTokens / tokensPerTurn));

    const health: ContextHealthState = {
      currentTokens,
      maxTokens,
      usagePercent,
      breakdown,
      warningLevel: getWarningLevel(usagePercent),
      estimatedTurnsRemaining,
      lastUpdated: Date.now(),
      compression: compression ?? previousHealth?.compression,
      // GAP-023: 被预算丢弃的 prompt 块可见化（undefined = 调用方没传，沿用上次；[] = 明确无丢弃）
      droppedPromptBlocks: droppedPromptBlocks ?? previousHealth?.droppedPromptBlocks,
      tokenSource: useProviderTruth ? 'provider' : 'estimated',
      ...(useProviderTruth ? { estimatedTokens: estimatedTotal } : {}),
    };

    // 保存状态
    this.sessionStates.set(sessionId, health);
    try {
      getSessionStateManager().updateContextHealth(sessionId, health);
    } catch (error) {
      logger.debug('Failed to mirror context health into session runtime state:', error);
    }

    // 发送事件到渲染进程
    this.emitHealthUpdate(sessionId, health);

    // 记录日志（仅在警告级别时）
    if (health.warningLevel !== 'normal') {
      logger.warn(
        `Context health ${health.warningLevel}: ${currentTokens}/${maxTokens} (${usagePercent}%) for session ${sessionId}`
      );
    }

    return health;
  }

  /**
   * 获取会话的健康状态
   */
  get(sessionId: string): ContextHealthState {
    return this.sessionStates.get(sessionId) || createEmptyHealthState();
  }

  /**
   * 获取最近更新的会话健康状态（用于无 sessionId 的场景）
   */
  getLatest(): ContextHealthState {
    let latest: ContextHealthState | null = null;
    for (const state of this.sessionStates.values()) {
      if (!latest || state.lastUpdated > latest.lastUpdated) {
        latest = state;
      }
    }
    return latest || createEmptyHealthState();
  }

  /**
   * 清理会话状态
   */
  cleanup(sessionId: string): void {
    this.sessionStates.delete(sessionId);
  }

  /**
   * 清理所有状态
   */
  clear(): void {
    this.sessionStates.clear();
  }

  /**
   * 更新平均 token 使用量（用于预测）
   */
  updateAverages(userTokens: number, assistantTokens: number): void {
    // 使用移动平均
    this.averageUserMessageTokens = Math.round(
      this.averageUserMessageTokens * 0.9 + userTokens * 0.1
    );
    this.averageAssistantMessageTokens = Math.round(
      this.averageAssistantMessageTokens * 0.9 + assistantTokens * 0.1
    );
  }

  /**
   * 发送健康更新事件到渲染进程
   */
  private emitHealthUpdate(sessionId: string, health: ContextHealthState): void {
    if (!this.mainWindow || this.mainWindow.isDestroyed()) {
      return;
    }

    const event: ContextHealthUpdateEvent = {
      sessionId,
      health,
    };

    try {
      this.mainWindow.webContents.send(IPC_CHANNELS.CONTEXT_HEALTH_EVENT, event);
    } catch (error) {
      logger.error('Failed to emit context health event:', error);
    }
  }
}

// ----------------------------------------------------------------------------
// Singleton Instance
// ----------------------------------------------------------------------------

let contextHealthServiceInstance: ContextHealthService | null = null;

/**
 * 获取 ContextHealthService 单例
 */
export function getContextHealthService(): ContextHealthService {
  if (!contextHealthServiceInstance) {
    contextHealthServiceInstance = new ContextHealthService();
  }
  return contextHealthServiceInstance;
}

/**
 * 初始化 ContextHealthService
 */
export function initContextHealthService(mainWindow: AppWindow): ContextHealthService {
  const service = getContextHealthService();
  service.setMainWindow(mainWindow);
  return service;
}
