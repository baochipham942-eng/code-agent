// ============================================================================
// Context Health Service - 上下文健康状态管理服务
// ============================================================================

import { BrowserWindow } from 'electron';
import { IPC_CHANNELS } from '../../shared/ipc';
import { CONTEXT_WINDOWS, DEFAULT_CONTEXT_WINDOW, DEFAULT_MODEL } from '../../shared/constants';
import {
  ContextHealthState,
  ContextHealthUpdateEvent,
  getWarningLevel,
  createEmptyHealthState,
  TokenBreakdown,
} from '../../shared/types/contextHealth';
import {
  estimateTokens,
  estimateConversationTokens,
} from './tokenEstimator';
import { createLogger } from '../services/infra/logger';

/**
 * Extended message type for context health tracking
 * Supports tool messages and tool results from AgentLoop
 */
export interface ContextMessage {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
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
    return CONTEXT_WINDOWS[model] || DEFAULT_CONTEXT_WINDOW;
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
    model: string = DEFAULT_MODEL
  ): ContextHealthState {
    const maxTokens = this.getModelContextLimit(model);

    // 计算各部分的 token 使用量
    const systemPromptTokens = estimateTokens(systemPrompt);
    const messagesTokens = this.calculateMessagesTokens(messages);
    const toolResultsTokens = this.calculateToolResultsTokens(messages);

    const breakdown: TokenBreakdown = {
      systemPrompt: systemPromptTokens,
      messages: messagesTokens,
      toolResults: toolResultsTokens,
    };

    const currentTokens = systemPromptTokens + messagesTokens + toolResultsTokens;
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
    };

    // 保存状态
    this.sessionStates.set(sessionId, health);

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
   * 计算工具结果的 token 数
   */
  private calculateToolResultsTokens(messages: ContextMessage[]): number {
    let totalTokens = 0;

    for (const message of messages) {
      // 工具调用的结果
      if (message.toolResults && message.toolResults.length > 0) {
        for (const result of message.toolResults) {
          // 计算 output 或 error 的 token 数
          if (result.output) {
            totalTokens += estimateTokens(result.output);
          }
          if (result.error) {
            totalTokens += estimateTokens(result.error);
          }
        }
      }

      // 工具消息
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
