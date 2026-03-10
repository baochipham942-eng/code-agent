// ============================================================================
// Channel Agent Bridge - 通道与 Agent 的桥接层
// ============================================================================

import type { AgentOrchestrator } from '../agent/agentOrchestrator';
import { getTaskManager } from '../task';
import type { ConfigService } from '../services/core/configService';
import { getChannelManager } from './channelManager';
import type { ChannelMessage, ChannelAttachment } from '../../shared/types/channel';
import type { MessageAttachment, Message, AgentEvent } from '../../shared/types';
import { ApiChannel } from './api/apiChannel';
import { createLogger } from '../services/infra/logger';
import { logCollector } from '../mcp/logCollector';
import { v4 as uuidv4 } from 'uuid';
import { IngressPipeline, type IngressMessage } from './ingressPipeline';

const logger = createLogger('ChannelAgentBridge');

/**
 * 通道 Agent 桥接配置
 */
export interface ChannelAgentBridgeConfig {
  getOrchestrator: () => AgentOrchestrator | null;
  configService: ConfigService;
}

/**
 * Session-aware orchestrator lookup.
 * Prefers per-session orchestrator from TaskManager; falls back to config getter.
 */
function getSessionAwareOrchestrator(
  config: ChannelAgentBridgeConfig,
): AgentOrchestrator | null {
  try {
    const tm = getTaskManager();
    const orchestrator = tm.getOrchestrator();
    if (orchestrator) return orchestrator;
  } catch {
    // TaskManager not yet initialized — fall through
  }
  return config.getOrchestrator();
}

/**
 * 通道 Agent 桥接类
 *
 * 负责将通道消息转换为 Agent 能理解的格式，
 * 并将 Agent 响应发回对应的通道
 */
export class ChannelAgentBridge {
  private config: ChannelAgentBridgeConfig;
  private channelManager = getChannelManager();
  private pipeline: IngressPipeline;

  // 追踪正在处理的消息
  private processingMessages: Map<string, {
    accountId: string;
    message: ChannelMessage;
    responseBuffer: string;
  }> = new Map();

  // 暂存入队消息的原始 ChannelMessage（供 pipeline 回调时使用）
  private pendingChannelMessages: Map<string, { accountId: string; message: ChannelMessage }> = new Map();

  constructor(config: ChannelAgentBridgeConfig) {
    this.config = config;
    this.pipeline = new IngressPipeline({
      processMessage: (msg) => this.processIngressMessage(msg),
    });
  }

  /**
   * 初始化桥接
   */
  async initialize(): Promise<void> {
    // 加载账号配置
    await this.channelManager.loadAccounts();

    // 自动创建 Telegram 通道（如果环境变量有 token 但还没有 telegram 账号）
    const hasTelegram = this.channelManager.getAccounts().some(a => a.type === 'telegram');
    if (!hasTelegram) {
      const tgToken = process.env.TELEGRAM_BOT_TOKEN;
      if (tgToken) {
        const proxyUrl = process.env.HTTPS_PROXY || process.env.https_proxy || undefined;
        await this.channelManager.addAccount('Telegram Bot', 'telegram', {
          type: 'telegram',
          botToken: tgToken,
          proxyUrl,
        });
        logger.info('Auto-created Telegram channel from TELEGRAM_BOT_TOKEN env');
      }
    }

    // 设置消息处理器
    this.channelManager.setMessageHandler(this.handleChannelMessage.bind(this));

    // 连接所有启用的账号
    await this.channelManager.connectAllEnabled();

    logger.info('ChannelAgentBridge initialized');
  }

  /**
   * 关闭桥接
   */
  async shutdown(): Promise<void> {
    this.pipeline.shutdown();
    this.pendingChannelMessages.clear();
    await this.channelManager.disconnectAll();
    this.processingMessages.clear();
    logger.info('ChannelAgentBridge shutdown');
  }

  /**
   * 获取 Ingress Pipeline 状态
   */
  getPipelineStats() {
    return this.pipeline.getStats();
  }

  /**
   * 处理来自通道的消息（入队到 Ingress Pipeline）
   */
  private async handleChannelMessage(
    accountId: string,
    message: ChannelMessage
  ): Promise<void> {
    logger.info('handleChannelMessage called', {
      accountId,
      messageId: message.id,
      content: message.content.substring(0, 50),
    });

    // 流式请求直接处理，不走 pipeline（需要保持 HTTP 连接）
    const isStreamingRequest = message.raw &&
      typeof message.raw === 'object' &&
      (message.raw as Record<string, unknown>).streaming === true;

    if (isStreamingRequest) {
      const orchestrator = getSessionAwareOrchestrator(this.config);
      if (!orchestrator) {
        await this.sendErrorResponse(accountId, message, 'Agent not available');
        return;
      }
      const attachments = this.convertAttachments(message.attachments);
      await this.handleStreamingMessage(accountId, message, orchestrator, attachments);
      return;
    }

    // 非流式消息走 Ingress Pipeline
    const sessionKey = `${accountId}:${message.context.chatId}`;
    const ingressKey = `${sessionKey}:${message.id}`;

    // 暂存原始消息供回调时使用
    this.pendingChannelMessages.set(ingressKey, { accountId, message });

    this.pipeline.enqueue({
      sessionKey,
      content: message.content,
      timestamp: message.timestamp,
      metadata: {
        accountId,
        messageId: message.id,
        ingressKey,
        attachments: message.attachments,
        sender: message.sender,
        context: message.context,
        raw: message.raw,
      },
    });
  }

  /**
   * Pipeline 回调：实际处理入队后的消息
   */
  private async processIngressMessage(msg: IngressMessage): Promise<void> {
    const meta = msg.metadata as Record<string, unknown>;
    const accountId = meta.accountId as string;
    const ingressKey = meta.ingressKey as string;

    // 恢复原始 ChannelMessage 或构造合成消息
    const pending = this.pendingChannelMessages.get(ingressKey);
    const message: ChannelMessage = pending?.message ?? {
      id: (meta.messageId as string) || uuidv4(),
      channelId: 'api' as any,
      sender: meta.sender as any,
      context: meta.context as any,
      content: msg.content,
      attachments: meta.attachments as ChannelAttachment[] | undefined,
      timestamp: msg.timestamp,
      raw: meta.raw,
    };

    // 清理暂存
    this.pendingChannelMessages.delete(ingressKey);

    // 使用合并后的内容（可能是多条消息 debounce 合并的）
    const processMessage: ChannelMessage = { ...message, content: msg.content };

    const orchestrator = getSessionAwareOrchestrator(this.config);
    if (!orchestrator) {
      logger.error('Orchestrator not available');
      await this.sendErrorResponse(accountId, processMessage, 'Agent not available');
      return;
    }

    const messageKey = `${accountId}:${processMessage.id}`;

    try {
      const attachments = this.convertAttachments(processMessage.attachments);

      this.processingMessages.set(messageKey, {
        accountId,
        message: processMessage,
        responseBuffer: '',
      });

      const responseCallback = this.channelManager.getResponseCallback(accountId, processMessage);
      if (!responseCallback) {
        throw new Error('Failed to get response callback');
      }

      await this.handleSyncMessage(accountId, processMessage, orchestrator, attachments, responseCallback);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.error('Error processing ingress message', { accountId, messageId: processMessage.id, error: errorMessage });
      await this.sendErrorResponse(accountId, processMessage, errorMessage);
    } finally {
      this.processingMessages.delete(messageKey);
    }
  }

  /**
   * 处理同步消息
   */
  private async handleSyncMessage(
    accountId: string,
    message: ChannelMessage,
    orchestrator: AgentOrchestrator,
    attachments: MessageAttachment[] | undefined,
    responseCallback: { sendText: (content: string) => Promise<{ success: boolean; messageId?: string; error?: string }> }
  ): Promise<void> {
    // 收集响应
    let fullResponse = '';
    const originalOnEvent = (orchestrator as unknown as { onEvent: (event: AgentEvent) => void }).onEvent;

    // 临时替换事件处理器以收集响应
    const collectResponse = (event: AgentEvent) => {
      if (event.type === 'message' && event.data) {
        const msg = event.data as Message;
        if (msg.role === 'assistant') {
          fullResponse = msg.content;
        }
      }
    };

    // 暂时监听响应（这是一个简化实现，实际可能需要更复杂的处理）
    // 由于 AgentOrchestrator 不直接支持这种模式，我们需要使用事件系统
    // 这里使用一个简化的方案：直接调用 sendMessage 并等待完成

    try {
      // 记录发送前的消息数量，用于识别新的回复
      const messagesBefore = orchestrator.getMessages();
      const messageCountBefore = messagesBefore.length;
      logCollector.log('agent', 'INFO', `[Channel] Processing message, count before: ${messageCountBefore}`);

      await orchestrator.sendMessage(message.content, attachments);
      logCollector.log('agent', 'INFO', '[Channel] orchestrator.sendMessage completed');

      // 获取新增的 assistant 消息作为响应
      const messagesAfter = orchestrator.getMessages();
      const countAfter = messagesAfter.length;
      logCollector.log('agent', 'INFO', `[Channel] Messages after: ${countAfter}, new: ${countAfter - messageCountBefore}`);

      // 只查找新增的消息中的 assistant 回复（找最后一条有内容的，跳过工具调用消息）
      const newMessages = messagesAfter.slice(messageCountBefore);
      const assistantMessages = newMessages.filter(m => m.role === 'assistant' && m.content && m.content.trim());
      const lastAssistantMessage = assistantMessages[assistantMessages.length - 1];

      if (lastAssistantMessage) {
        fullResponse = lastAssistantMessage.content;
        logCollector.log('agent', 'INFO', `[Channel] Found response: ${fullResponse.substring(0, 100)}...`);
      } else {
        logCollector.log('agent', 'WARN', `[Channel] No assistant message with content found in ${newMessages.length} new messages`);
      }

      // 发送响应
      logCollector.log('agent', 'INFO', `[Channel] Sending response (length: ${fullResponse.length})`);
      if (fullResponse) {
        const result = await responseCallback.sendText(fullResponse);
        logCollector.log('agent', 'INFO', `[Channel] Response sent: success=${result.success}, error=${result.error || 'none'}`);
      } else {
        const result = await responseCallback.sendText('处理完成，但没有生成响应。');
        logCollector.log('agent', 'INFO', `[Channel] Default response sent: success=${result.success}`);
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      logCollector.log('agent', 'ERROR', `[Channel] Error: ${errorMsg}`);
      await responseCallback.sendText(`处理失败: ${errorMsg}`);
    }
  }

  /**
   * 处理流式消息 (HTTP API 专用)
   *
   * 通过临时拦截 orchestrator 的 onEvent 回调，将 stream_chunk 等事件
   * 实时推送到 SSE 连接，实现真正的流式响应。
   * SSE 格式: `data: ${JSON.stringify(event)}\n\n`，流结束发送 `data: [DONE]\n\n`
   */
  private async handleStreamingMessage(
    accountId: string,
    message: ChannelMessage,
    orchestrator: AgentOrchestrator,
    attachments: MessageAttachment[] | undefined
  ): Promise<void> {
    const raw = message.raw as Record<string, unknown>;
    const res = raw.res as { write: (data: string) => void; end: () => void; writableEnded?: boolean };

    if (!res) {
      throw new Error('No response object for streaming');
    }

    // Per-request SSE handler: use addListener/removeListener instead of
    // overwriting the global onEvent, so concurrent streams don't clobber
    // each other (fixes Sprint 3 review #2).
    const orchestratorInternal = orchestrator as unknown as {
      onEvent: (event: AgentEvent) => void;
      on?: (event: string, handler: (event: AgentEvent) => void) => void;
      removeListener?: (event: string, handler: (event: AgentEvent) => void) => void;
    };

    // Helper: write with backpressure handling (fixes Sprint 3 review #3)
    const safeWrite = async (chunk: string): Promise<void> => {
      if (res.writableEnded) return;
      const ok = (res as unknown as { write: (data: string) => boolean }).write(chunk);
      if (!ok) {
        await new Promise<void>(resolve => (res as unknown as NodeJS.WritableStream).once('drain', resolve));
      }
    };

    // Track whether client disconnected
    let clientDisconnected = false;
    const req = raw.req as { on?: (event: string, handler: () => void) => void } | undefined;
    if (req?.on) {
      req.on('close', () => { clientDisconnected = true; });
    }

    const sseListener = async (event: AgentEvent) => {
      if (clientDisconnected || res.writableEnded) return;

      switch (event.type) {
        case 'stream_chunk':
          if (event.data.content) {
            await safeWrite(`data: ${JSON.stringify({ type: 'stream_chunk', content: event.data.content })}\n\n`);
          }
          break;
        case 'stream_reasoning':
          if (event.data.content) {
            await safeWrite(`data: ${JSON.stringify({ type: 'stream_reasoning', content: event.data.content })}\n\n`);
          }
          break;
        case 'tool_call_start':
          await safeWrite(`data: ${JSON.stringify({ type: 'tool_call_start', name: event.data.name })}\n\n`);
          break;
        case 'tool_call_end':
          await safeWrite(`data: ${JSON.stringify({ type: 'tool_call_end', toolCallId: event.data.toolCallId })}\n\n`);
          break;
        case 'error':
          await safeWrite(`data: ${JSON.stringify({ type: 'error', error: event.data.message })}\n\n`);
          break;
      }
    };

    // Wrap async listener for EventEmitter compatibility
    const syncListener = (event: AgentEvent) => { void sseListener(event); };

    // Prefer EventEmitter-style addListener if available; fall back to wrapping onEvent
    const useEventEmitter = typeof orchestratorInternal.on === 'function'
      && typeof orchestratorInternal.removeListener === 'function';

    let originalOnEvent: ((event: AgentEvent) => void) | undefined;

    if (useEventEmitter) {
      orchestratorInternal.on!('event', syncListener);
    } else {
      // Fallback: wrap existing onEvent (single-request safe, still better than raw overwrite)
      originalOnEvent = orchestratorInternal.onEvent;
      orchestratorInternal.onEvent = (event: AgentEvent) => {
        originalOnEvent!.call(orchestrator, event);
        syncListener(event);
      };
    }

    try {
      await orchestrator.sendMessage(message.content, attachments);

      if (!res.writableEnded && !clientDisconnected) {
        await safeWrite('data: [DONE]\n\n');
        res.end();
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      if (!res.writableEnded && !clientDisconnected) {
        await safeWrite(`data: ${JSON.stringify({ type: 'error', error: errorMsg })}\n\n`);
        await safeWrite('data: [DONE]\n\n');
        res.end();
      }
    } finally {
      // Clean up: remove per-request listener without affecting other streams
      if (useEventEmitter) {
        orchestratorInternal.removeListener!('event', syncListener);
      } else if (originalOnEvent) {
        orchestratorInternal.onEvent = originalOnEvent;
      }
    }
  }

  /**
   * 发送错误响应
   */
  private async sendErrorResponse(
    accountId: string,
    message: ChannelMessage,
    errorMessage: string
  ): Promise<void> {
    try {
      const channel = this.channelManager['activeChannels'].get(accountId);
      if (channel instanceof ApiChannel) {
        (channel as ApiChannel).rejectRequest(message.id, new Error(errorMessage));
      } else {
        await this.channelManager.sendMessage(
          accountId,
          message.context.chatId,
          `错误: ${errorMessage}`,
          { replyToMessageId: message.id }
        );
      }
    } catch (e) {
      logger.error('Failed to send error response', { error: e });
    }
  }

  /**
   * 转换附件格式
   */
  private convertAttachments(
    channelAttachments?: ChannelAttachment[]
  ): MessageAttachment[] | undefined {
    if (!channelAttachments || channelAttachments.length === 0) {
      return undefined;
    }

    return channelAttachments.map(att => ({
      id: att.id,
      type: att.type === 'image' ? 'image' : 'file',
      category: this.getAttachmentCategory(att),
      name: att.name,
      size: att.size || 0,
      mimeType: att.mimeType || 'application/octet-stream',
      data: att.data,
      path: att.url,
    }));
  }

  /**
   * 获取附件分类
   */
  private getAttachmentCategory(att: ChannelAttachment): 'image' | 'pdf' | 'text' | 'code' | 'data' | 'other' {
    if (att.type === 'image') return 'image';
    if (att.mimeType?.includes('pdf')) return 'pdf';
    if (att.mimeType?.includes('text')) return 'text';
    if (att.mimeType?.includes('json') || att.mimeType?.includes('csv')) return 'data';
    return 'other';
  }
}

// 单例
let bridgeInstance: ChannelAgentBridge | null = null;

/**
 * 初始化并获取 ChannelAgentBridge 实例
 */
export function initChannelAgentBridge(config: ChannelAgentBridgeConfig): ChannelAgentBridge {
  if (!bridgeInstance) {
    bridgeInstance = new ChannelAgentBridge(config);
  }
  return bridgeInstance;
}

/**
 * 获取 ChannelAgentBridge 实例
 */
export function getChannelAgentBridge(): ChannelAgentBridge | null {
  return bridgeInstance;
}
