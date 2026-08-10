// ============================================================================
// Orchestrator Message History - In-memory conversation and compression state
// ============================================================================

import type { Message } from '../../shared/contract';
import type { AgentRunOptions } from '../research/types';
import type { AgentLoop } from './agentLoop';
import { createLogger } from '../services/infra/logger';
import { MAX_MESSAGES_IN_MEMORY } from './orchestrator/types';

const logger = createLogger('AgentOrchestrator');

/** 承载消息历史与压缩状态；原始数组仅供同一 orchestrator 的运行链路使用。 */
export class OrchestratorMessageHistory {
  private messages: Message[] = [];
  private lastSerializedCompressionState: string | null = null;

  constructor(private readonly getAgentLoop: () => AgentLoop | null) {}

  setMessages(messages: Message[]): void {
    this.messages = [...messages];
    logger.debug(`Messages set, count: ${this.messages.length}`);
  }

  getMessages(): Message[] {
    return [...this.messages];
  }

  /** 仅供 AgentLoop 与 orchestrator 内部共享同一历史数组，保持既有引用语义。 */
  getMessagesForRun(): Message[] {
    return this.messages;
  }

  getSerializedCompressionState(): string | null {
    const liveState = this.getAgentLoop()?.getSerializedCompressionState() ?? null;
    if (liveState) {
      this.lastSerializedCompressionState = liveState;
    }
    return liveState ?? this.lastSerializedCompressionState;
  }

  captureCompressionState(): void {
    this.lastSerializedCompressionState = this.getAgentLoop()?.getSerializedCompressionState()
      ?? this.lastSerializedCompressionState;
  }

  clearMessages(): void {
    this.messages = [];
    logger.debug('Messages cleared');
  }

  addMessage(message: Message): void {
    this.messages.push(message);
    if (this.messages.length > MAX_MESSAGES_IN_MEMORY) {
      const trimCount = this.messages.length - MAX_MESSAGES_IN_MEMORY;
      this.messages = this.messages.slice(trimCount);
      logger.debug(`Trimmed ${trimCount} old messages, keeping ${this.messages.length}`);
    }
  }

  applyHistoryVisibility(message: Message, options?: AgentRunOptions): Message {
    if (options?.historyVisibility === 'meta') {
      message.isMeta = true;
      message.source = message.source ?? 'system';
    }
    return message;
  }
}
