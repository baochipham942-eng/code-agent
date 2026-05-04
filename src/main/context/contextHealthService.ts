// ============================================================================
// Context Health Service - 上下文健康状态管理服务
// ============================================================================

import { BrowserWindow } from '../platform';
import { IPC_CHANNELS } from '../../shared/ipc';
import { getContextWindow, DEFAULT_MODEL } from '../../shared/constants';
import {
  ContextHealthState,
  ContextHealthUpdateEvent,
  CompressionStats,
  getWarningLevel,
  createEmptyHealthState,
  TokenBreakdown,
} from '../../shared/contract/contextHealth';
import {
  estimateTokens,
  estimateConversationTokens,
} from './tokenEstimator';
import { createLogger } from '../services/infra/logger';
import { getSessionStateManager } from '../session/sessionStateManager';
import type { ToolCall } from '../../shared/contract';
import { getCoreToolDefinitions, getLoadedDeferredToolDefinitions } from '../tools/dispatch/toolDefinitions';

/**
 * Extended message type for context health tracking
 * Supports tool messages and tool results from AgentLoop
 */
export interface ContextMessage {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  toolCalls?: ToolCall[];
  toolResults?: Array<{
    output?: string;
    error?: string;
  }>;
}

const logger = createLogger('ContextHealthService');

// Context window sizes sourced from shared constants

// ----------------------------------------------------------------------------
// Context Health Service
// ----------------------------------------------------------------------------

/**
 * 上下文健康服务
 *
 * 负责跟踪和报告每个会话的上下文使用情况
 */
export class ContextHealthService {
  private sessionStates: Map<string, ContextHealthState> = new Map();
  private mainWindow: BrowserWindow | null = null;
  private averageUserMessageTokens: number = 200; // 用户消息平均 tokens
  private averageAssistantMessageTokens: number = 800; // 助手消息平均 tokens

  // 工具 schema token 估算缓存：tool 数量+签名 hash 不变时复用
  private toolDefTokensCache: { signature: string; tokens: number } | null = null;

  /**
   * 估算当前活跃工具 schema 序列化后的 token 占用。
   * 每次推理都会把这一坨发给模型（name + description + inputSchema JSON），
   * 不算进 currentTokens 会让 UI 显示比真实 input 偏低（小红书 session 漏算 ~14k）。
   */
  private estimateActiveToolDefinitionsTokens(): number {
    try {
      const core = getCoreToolDefinitions();
      const deferred = getLoadedDeferredToolDefinitions();
      const all = [...core, ...deferred];
      const signature = `${all.length}:${all.map((t) => t.name).join(',')}`;
      if (this.toolDefTokensCache?.signature === signature) {
        return this.toolDefTokensCache.tokens;
      }
      const serialized = JSON.stringify(all.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
      })));
      const tokens = estimateTokens(serialized);
      this.toolDefTokensCache = { signature, tokens };
      return tokens;
    } catch (error) {
      logger.debug('estimateActiveToolDefinitionsTokens failed, returning 0:', error);
      return 0;
    }
  }

  /**
   * 设置主窗口用于发送事件
   */
  setMainWindow(window: BrowserWindow | null): void {
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
   */
  update(
    sessionId: string,
    messages: ContextMessage[],
    systemPrompt: string,
    model: string = DEFAULT_MODEL,
    compression?: CompressionStats,
    toolDefinitionsTokens?: number,
  ): ContextHealthState {
    const maxTokens = this.getModelContextLimit(model);
    const previousHealth = this.sessionStates.get(sessionId);

    // 计算各部分的 token 使用量
    const systemPromptTokens = estimateTokens(systemPrompt);
    const messagesTokens = this.calculateMessagesTokens(messages) + this.calculateToolCallTokens(messages);
    const toolResultsTokens = this.calculateToolResultsTokens(messages);
    // 工具 schema 定义：每次请求都会发给模型（包含 name/description/inputSchema JSON）。
    // 优先用调用方显式传值，否则自动从工具 registry 估算（registry 不可用时回退 0）。
    const toolDefTokens = toolDefinitionsTokens ?? this.estimateActiveToolDefinitionsTokens();

    const breakdown: TokenBreakdown = {
      systemPrompt: systemPromptTokens,
      messages: messagesTokens,
      toolResults: toolResultsTokens,
      toolDefinitions: toolDefTokens,
    };

    const currentTokens = systemPromptTokens + messagesTokens + toolResultsTokens + toolDefTokens;
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

  // --------------------------------------------------------------------------
  // Private Methods
  // --------------------------------------------------------------------------

  /**
   * 计算消息历史的 token 数（不含工具结果）
   */
  private calculateMessagesTokens(messages: ContextMessage[]): number {
    // 过滤掉工具结果消息，并转换为 tokenEstimator 需要的格式
    const nonToolMessages = messages
      .filter((msg) => msg.role !== 'tool')
      .map(msg => ({
        role: msg.role as 'user' | 'assistant' | 'system',
        content: msg.content,
      }));
    return estimateConversationTokens(nonToolMessages);
  }

  /**
   * 计算 assistant tool calls 的 token 数。
   *
   * 许多运行轨迹会把 assistant 消息正文留空，只把真实模型上下文放在
   * tool_calls JSON 里；如果不计这部分，Context Usage 会被低估到接近 0。
   */
  private calculateToolCallTokens(messages: ContextMessage[]): number {
    let totalTokens = 0;

    for (const message of messages) {
      if (!message.toolCalls?.length) continue;

      for (const toolCall of message.toolCalls) {
        let args = '';
        try {
          args = JSON.stringify(toolCall.arguments ?? {});
        } catch {
          args = String(toolCall.arguments ?? '');
        }

        const text = [
          toolCall.name,
          toolCall.shortDescription || '',
          args,
        ].filter(Boolean).join('\n');

        totalTokens += estimateTokens(text);
      }
    }

    return totalTokens;
  }

  /**
   * 计算工具结果的 token 数
   */
  private calculateToolResultsTokens(messages: ContextMessage[]): number {
    let totalTokens = 0;

    for (const message of messages) {
      // role=tool 消息：content 已是 JSON.stringify(toolResults)，直接计 content 即可。
      // 不再计 message.toolResults 数组，避免与 content 双计。
      if (message.role === 'tool') {
        totalTokens += estimateTokens(message.content);
      }
    }

    return totalTokens;
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
export function initContextHealthService(mainWindow: BrowserWindow): ContextHealthService {
  const service = getContextHealthService();
  service.setMainWindow(mainWindow);
  return service;
}
