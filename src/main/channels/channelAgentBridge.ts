// ============================================================================
// Channel Agent Bridge - 通道与 Agent 的桥接层
// ============================================================================

import type { AgentOrchestrator } from '../agent/agentOrchestrator';
import type { GenerationManager } from '../generation/generationManager';
import type { ConfigService } from '../services/core/configService';
import { getChannelManager } from './channelManager';
import type { ChannelMessage, ChannelAttachment } from '../../shared/types/channel';
import type { MessageAttachment, Message, AgentEvent } from '../../shared/types';
import { ApiChannel } from './api/apiChannel';
import { createLogger } from '../services/infra/logger';
import { logCollector } from '../mcp/logCollector';
import { v4 as uuidv4 } from 'uuid';

const logger = createLogger('ChannelAgentBridge');

/**
 * 通道 Agent 桥接配置
 */
export interface ChannelAgentBridgeConfig {
  getOrchestrator: () => AgentOrchestrator | null;
  generationManager: GenerationManager;
  configService: ConfigService;
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

  // 追踪正在处理的消息
  private processingMessages: Map<string, {
    accountId: string;
    message: ChannelMessage;
    responseBuffer: string;
  }> = new Map();

  constructor(config: ChannelAgentBridgeConfig) {
    this.config = config;
  }

  /**
   * 初始化桥接
   */
  async initialize(): Promise<void> {
    // 加载账号配置
    await this.channelManager.loadAccounts();

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
    await this.channelManager.disconnectAll();
    this.processingMessages.clear();
    logger.info('ChannelAgentBridge shutdown');
  }

  /**
   * 处理来自通道的消息
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

    const orchestrator = this.config.getOrchestrator();
    if (!orchestrator) {
      logger.error('Orchestrator not available');
      await this.sendErrorResponse(accountId, message, 'Agent not available');
      return;
    }
    logger.info('Orchestrator available, processing message...');

    const messageKey = `${accountId}:${message.id}`;

    try {
      logger.info('Processing channel message', {
        accountId,
        messageId: message.id,
        sender: message.sender.name,
        content: message.content.substring(0, 100),
      });

      // 转换附件格式
      const attachments = this.convertAttachments(message.attachments);

      // 创建消息追踪
      this.processingMessages.set(messageKey, {
        accountId,
        message,
        responseBuffer: '',
      });

      // 创建专门的事件处理器
      const responseCallback = this.channelManager.getResponseCallback(accountId, message);
      if (!responseCallback) {
        throw new Error('Failed to get response callback');
      }

      // 检查是否是 HTTP API 流式请求
      const isStreamingRequest = message.raw &&
        typeof message.raw === 'object' &&
        (message.raw as Record<string, unknown>).streaming === true;

      if (isStreamingRequest) {
        // 流式处理
        await this.handleStreamingMessage(accountId, message, orchestrator, attachments);
      } else {
        // 同步处理
        await this.handleSyncMessage(accountId, message, orchestrator, attachments, responseCallback);
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.error('Error processing channel message', { accountId, messageId: message.id, error: errorMessage });
      await this.sendErrorResponse(accountId, message, errorMessage);
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
   */
  private async handleStreamingMessage(
    accountId: string,
    message: ChannelMessage,
    orchestrator: AgentOrchestrator,
    attachments: MessageAttachment[] | undefined
  ): Promise<void> {
    const raw = message.raw as Record<string, unknown>;
    const res = raw.res as { write: (data: string) => void; end: () => void };

    if (!res) {
      throw new Error('No response object for streaming');
    }

    // TODO: 实现真正的流式响应
    // 当前简化实现：等待完成后一次性返回
    try {
      await orchestrator.sendMessage(message.content, attachments);

      const messages = orchestrator.getMessages();
      const lastAssistantMessage = messages.filter(m => m.role === 'assistant').pop();

      if (lastAssistantMessage) {
        res.write(`data: ${JSON.stringify({ content: lastAssistantMessage.content })}\n\n`);
      }

      res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
      res.end();
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      res.write(`data: ${JSON.stringify({ error: errorMsg })}\n\n`);
      res.end();
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
