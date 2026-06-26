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
  createEmptySourceBreakdown,
  TokenBreakdown,
  SourceTag,
  SourceBreakdown,
} from '../../shared/contract/contextHealth';
import {
  estimateTokens,
  estimateConversationTokens,
} from './tokenEstimator';
import { createLogger } from '../services/infra/logger';
import { getSessionStateManager } from '../session/sessionStateManager';
import type { ToolCall } from '../../shared/contract';

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
// IPC 广播 debounce 间隔：recordSourceContribution 在单 turn 内可能被高频调用
// （多次 tool result），避免风暴
const SOURCE_CONTRIBUTION_DEBOUNCE_MS = 200;

export class ContextHealthService {
  private sessionStates: Map<string, ContextHealthState> = new Map();
  private mainWindow: AppWindow | null = null;
  private averageUserMessageTokens: number = 200; // 用户消息平均 tokens
  private averageAssistantMessageTokens: number = 800; // 助手消息平均 tokens

  // bySource 更新的 debounce 定时器（每 session 一个）
  private sourceDebounceTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();

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
   */
  update(
    sessionId: string,
    messages: ContextMessage[],
    systemPrompt: string,
    model: string = DEFAULT_MODEL,
    compression?: CompressionStats,
    toolDefinitionsTokens?: number,
    droppedPromptBlocks?: string[],
  ): ContextHealthState {
    const maxTokens = this.getModelContextLimit(model);
    const previousHealth = this.sessionStates.get(sessionId);

    // 计算各部分的 token 使用量
    const systemPromptTokens = estimateTokens(systemPrompt);
    const messagesTokens = this.calculateMessagesTokens(messages) + this.calculateToolCallTokens(messages);
    const toolResultsTokens = this.calculateToolResultsTokens(messages);
    // 工具 schema 定义：每次请求都会发给模型（包含 name/description/inputSchema JSON）。
    // 优先用调用方显式传值，否则自动从工具 registry 估算（registry 不可用时回退 0）。
    const toolDefTokens = toolDefinitionsTokens ?? 0;

    // 保留上轮的 bySource 累加值（recordSourceContribution 之间的状态）
    // 同时把 conversation 字段按扣减法重算：messages - 其他 source 之和
    const bySource: SourceBreakdown =
      previousHealth?.breakdown.bySource ?? createEmptySourceBreakdown();
    const otherSourceSum =
      bySource.rules +
      Object.values(bySource.skills).reduce((a, b) => a + b, 0) +
      Object.values(bySource.mcp).reduce((a, b) => a + b, 0) +
      Object.values(bySource.subagents).reduce((a, b) => a + b, 0) +
      bySource.fileReads;
    bySource.conversation = Math.max(0, messagesTokens - otherSourceSum);

    const breakdown: TokenBreakdown = {
      systemPrompt: systemPromptTokens,
      messages: messagesTokens,
      toolResults: toolResultsTokens,
      toolDefinitions: toolDefTokens,
      bySource,
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
      // GAP-023: 被预算丢弃的 prompt 块可见化（undefined = 调用方没传，沿用上次；[] = 明确无丢弃）
      droppedPromptBlocks: droppedPromptBlocks ?? previousHealth?.droppedPromptBlocks,
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
    const timer = this.sourceDebounceTimers.get(sessionId);
    if (timer) {
      clearTimeout(timer);
      this.sourceDebounceTimers.delete(sessionId);
    }
  }

  /**
   * 清理所有状态
   */
  clear(): void {
    this.sessionStates.clear();
    for (const timer of this.sourceDebounceTimers.values()) {
      clearTimeout(timer);
    }
    this.sourceDebounceTimers.clear();
  }

  // --------------------------------------------------------------------------
  // bySource 上下文来源追踪（产品维度）
  //
  // 用法语义：
  //   - mode='add'（默认）：累加。tool result/fileRead/subagent 输出每次有新内容时调用
  //   - mode='set'：替换。skill 挂载/MCP 注册时调用，给出该来源当前总占用
  //   - clearSourceContribution：skill 卸载/MCP 断开时调用，从 bySource 移除
  //   - resetSourceContributions：压缩或 session reset 时整体清零
  //
  // 注意：conversation 字段是派生值（messages - 其他 source 之和），
  // 不应直接 record，调用会被忽略。
  // --------------------------------------------------------------------------

  /**
   * 记录某个产品来源的 token 贡献
   */
  recordSourceContribution(
    sessionId: string,
    source: SourceTag,
    tokens: number,
    mode: 'add' | 'set' = 'add',
  ): void {
    if (tokens < 0 || !Number.isFinite(tokens)) {
      logger.debug('recordSourceContribution ignored invalid tokens:', { source, tokens });
      return;
    }

    const state = this.ensureStateWithBySource(sessionId);
    const bs = state.breakdown.bySource!;

    switch (source.type) {
      case 'rule':
        bs.rules = mode === 'set' ? tokens : bs.rules + tokens;
        break;
      case 'skill':
        bs.skills[source.name] =
          mode === 'set' ? tokens : (bs.skills[source.name] ?? 0) + tokens;
        break;
      case 'mcp':
        bs.mcp[source.server] =
          mode === 'set' ? tokens : (bs.mcp[source.server] ?? 0) + tokens;
        break;
      case 'subagent':
        bs.subagents[source.name] =
          mode === 'set' ? tokens : (bs.subagents[source.name] ?? 0) + tokens;
        break;
      case 'fileRead':
        bs.fileReads = mode === 'set' ? tokens : bs.fileReads + tokens;
        break;
      case 'conversation':
        // 派生值，update() 时按扣减法计算，不接受直接写入
        return;
    }

    this.emitSourceUpdateDebounced(sessionId);
  }

  /**
   * 清除某个具名来源的贡献（skill 卸载 / MCP 断开 / 标量来源归 0）
   */
  clearSourceContribution(sessionId: string, source: SourceTag): void {
    const state = this.sessionStates.get(sessionId);
    if (!state?.breakdown.bySource) return;
    const bs = state.breakdown.bySource;

    switch (source.type) {
      case 'rule':
        bs.rules = 0;
        break;
      case 'skill':
        delete bs.skills[source.name];
        break;
      case 'mcp':
        delete bs.mcp[source.server];
        break;
      case 'subagent':
        delete bs.subagents[source.name];
        break;
      case 'fileRead':
        bs.fileReads = 0;
        break;
      case 'conversation':
        bs.conversation = 0;
        break;
    }

    this.emitSourceUpdateDebounced(sessionId);
  }

  /**
   * 重置 session 的 bySource（压缩后或 session 重启时调用）
   */
  resetSourceContributions(sessionId: string): void {
    const state = this.sessionStates.get(sessionId);
    if (!state) return;
    state.breakdown.bySource = createEmptySourceBreakdown();
    this.emitSourceUpdateDebounced(sessionId);
  }

  /**
   * 跨所有 session 清除某个 MCP server 的 bySource 占用
   * 用于全局事件：MCP server 被 disable 时，所有 session 应同步清掉
   */
  clearMcpServerAcrossSessions(serverName: string): void {
    for (const [sid, state] of this.sessionStates.entries()) {
      if (!state.breakdown.bySource) continue;
      if (state.breakdown.bySource.mcp[serverName] !== undefined) {
        delete state.breakdown.bySource.mcp[serverName];
        this.emitSourceUpdateDebounced(sid);
      }
    }
  }

  /**
   * 确保 session 状态存在且 bySource 已初始化
   * 在 record 路径上需要：若没有 update() 跑过，先用空 health state 兜底
   */
  private ensureStateWithBySource(sessionId: string): ContextHealthState {
    let state = this.sessionStates.get(sessionId);
    if (!state) {
      state = createEmptyHealthState();
      this.sessionStates.set(sessionId, state);
    }
    if (!state.breakdown.bySource) {
      state.breakdown.bySource = createEmptySourceBreakdown();
    }
    return state;
  }

  /**
   * 防抖广播 source 维度更新
   * 单 turn 内多次 record 不会触发 IPC 风暴
   */
  private emitSourceUpdateDebounced(sessionId: string): void {
    const existing = this.sourceDebounceTimers.get(sessionId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.sourceDebounceTimers.delete(sessionId);
      const state = this.sessionStates.get(sessionId);
      if (state) this.emitHealthUpdate(sessionId, state);
    }, SOURCE_CONTRIBUTION_DEBOUNCE_MS);
    this.sourceDebounceTimers.set(sessionId, timer);
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
        let args: string;
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
export function initContextHealthService(mainWindow: AppWindow): ContextHealthService {
  const service = getContextHealthService();
  service.setMainWindow(mainWindow);
  return service;
}
