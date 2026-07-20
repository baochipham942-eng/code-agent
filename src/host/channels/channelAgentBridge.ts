// ============================================================================
// Channel Agent Bridge - 通道与 Agent 的桥接层
// ============================================================================

import type { AgentOrchestrator } from '../agent/agentOrchestrator';
import { getTaskManager } from '../task';
import type { ConfigService } from '../services/core/configService';
import { getSessionManager } from '../services';
import { getChannelManager } from './channelManager';
import type { ChannelMessage, ChannelAttachment, ChannelContext, ChannelSender } from '../../shared/contract/channel';
import type { AttachmentCategory, MessageAttachment, AgentEvent, ModelConfig, MessageMetadata } from '../../shared/contract';
import { createLogger } from '../services/infra/logger';
import { logCollector } from '../mcp/logCollector';
import { v4 as uuidv4 } from 'uuid';
import { IngressPipeline, type IngressMessage, type IngressMessagePart } from './ingressPipeline';
import { resolveSessionDefaultModelConfig } from '../services/core/sessionDefaults';
import { summarizeUserFacingError } from '../security/userFacingError';
import type { ChannelResponseCallback } from './channelInterface';
import { summarizeChannelError } from './channelErrorSummary';
import { CHANNEL_INGRESS } from '../../shared/constants';
import { transcribeAudioFile } from '../services/media/audioTranscriptionService';
import { sanitizeChannelText } from './privacy/channelPrivacyFirewall';

const logger = createLogger('ChannelAgentBridge');

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function toChannelSender(value: unknown): ChannelSender {
  if (isRecord(value) && typeof value.id === 'string' && typeof value.name === 'string') {
    return {
      id: value.id,
      name: value.name,
      avatarUrl: typeof value.avatarUrl === 'string' ? value.avatarUrl : undefined,
      isBot: typeof value.isBot === 'boolean' ? value.isBot : undefined,
    };
  }

  return { id: 'api', name: 'API' };
}

function toChannelContext(value: unknown): ChannelContext {
  if (
    isRecord(value) &&
    typeof value.chatId === 'string' &&
    (value.chatType === 'p2p' || value.chatType === 'group' || value.chatType === 'channel')
  ) {
    return {
      chatId: value.chatId,
      chatType: value.chatType,
      chatName: typeof value.chatName === 'string' ? value.chatName : undefined,
      threadId: typeof value.threadId === 'string' ? value.threadId : undefined,
      replyToMessageId: typeof value.replyToMessageId === 'string' ? value.replyToMessageId : undefined,
    };
  }

  return { chatId: 'api', chatType: 'p2p' };
}

/**
 * 通道 Agent 桥接配置
 */
export interface ChannelAgentBridgeConfig {
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
  private pipeline: IngressPipeline;
  private channelSessions: Map<string, string> = new Map();

  // 追踪正在处理的消息
  private processingMessages: Map<string, {
    accountId: string;
    message: ChannelMessage;
    responseBuffer: string;
  }> = new Map();

  // 暂存入队消息的原始 ChannelMessage（供 pipeline 回调时使用）
  private pendingChannelMessages: Map<string, { accountId: string; message: ChannelMessage }> = new Map();
  private processedMessages: Map<string, { status: 'processing' | 'completed' | 'failed'; timestamp: number }> = new Map();
  private readonly processedMessageTtlMs = 24 * 60 * 60 * 1000;

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
    this.channelSessions.clear();
    this.pendingChannelMessages.clear();
    await this.channelManager.disconnectAll();
    this.processingMessages.clear();
    this.processedMessages.clear();
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
      contentLength: message.content.length,
    });

    const sessionKey = this.getSessionKey(accountId, message);
    if (!this.markMessageProcessing(accountId, message.id)) {
      logger.info('Ignoring duplicate channel message', {
        accountId,
        messageId: message.id,
        sessionKey,
      });
      return;
    }

    // 流式请求直接处理，不走 pipeline（需要保持 HTTP 连接）
    const isStreamingRequest = message.raw &&
      typeof message.raw === 'object' &&
      (message.raw as Record<string, unknown>).streaming === true;

    if (isStreamingRequest) {
      const orchestrator = await this.getOrCreateChannelOrchestrator(sessionKey, accountId, message);
      if (!orchestrator) {
        await this.sendErrorResponse(accountId, message, 'Agent not available');
        this.markMessageFailed(accountId, message.id);
        return;
      }
      const attachments = this.convertAttachments(message.attachments);
      try {
        await this.handleStreamingMessage(accountId, message, orchestrator, attachments);
        this.markMessageCompleted(accountId, message.id);
      } catch (error) {
        this.markMessageFailed(accountId, message.id);
        throw error;
      }
      return;
    }

    // 非流式消息走 Ingress Pipeline
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
    const parts = this.getIngressParts(msg);

    // 恢复原始 ChannelMessage 或构造合成消息
    const firstPart = parts[0];
    const firstMeta = firstPart?.metadata ?? meta;
    const firstIngressKey = typeof firstMeta.ingressKey === 'string' ? firstMeta.ingressKey : ingressKey;
    const pending = this.pendingChannelMessages.get(firstIngressKey);
    const message: ChannelMessage = pending?.message ?? {
      id: (firstMeta.messageId as string) || uuidv4(),
      channelId: 'api',
      sender: toChannelSender(firstMeta.sender),
      context: toChannelContext(firstMeta.context),
      content: msg.content,
      attachments: this.collectPartAttachments(parts),
      timestamp: msg.timestamp,
      raw: firstMeta.raw,
    };

    // 清理暂存
    for (const part of parts) {
      const partIngressKey = part.metadata?.ingressKey;
      if (typeof partIngressKey === 'string') {
        this.pendingChannelMessages.delete(partIngressKey);
      }
    }

    // 使用合并后的内容（可能是多条消息 debounce 合并的）
    const processMessage: ChannelMessage = {
      ...message,
      content: msg.content,
      attachments: this.collectPartAttachments(parts) ?? message.attachments,
      timestamp: msg.timestamp,
    };

    const sessionKey = this.getSessionKey(accountId, processMessage);
    const orchestrator = await this.getOrCreateChannelOrchestrator(sessionKey, accountId, processMessage);
    if (!orchestrator) {
      logger.error('Orchestrator not available');
      await this.sendErrorResponse(accountId, processMessage, 'Agent not available');
      this.markPartsFailed(accountId, parts);
      return;
    }

    const messageKey = `${accountId}:${processMessage.id}`;

    try {
      const enrichment = await this.enrichChannelMessage(processMessage);
      const attachments = this.convertAttachments(enrichment.attachments);
      processMessage.content = enrichment.content;
      processMessage.attachments = enrichment.attachments;

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
      this.markPartsCompleted(accountId, parts);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      const { summary } = summarizeUserFacingError(error, { surface: 'channel_reply' });
      logger.error('Error processing ingress message', { accountId, messageId: processMessage.id, error: errorMessage });
      await this.sendErrorResponse(accountId, processMessage, summary);
      this.markPartsFailed(accountId, parts);
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
    responseCallback: ChannelResponseCallback
  ): Promise<void> {
    // 收集响应
    let fullResponse = '';
    try {
      await this.startTyping(responseCallback);
      // 记录发送前的消息数量，用于识别新的回复
      const messagesBefore = orchestrator.getMessages();
      const messageCountBefore = messagesBefore.length;
      logCollector.log('agent', 'INFO', `[Channel] Processing message, count before: ${messageCountBefore}`);

      await orchestrator.sendMessage(
        message.content,
        attachments,
        undefined,
        this.buildChannelMessageMetadata(accountId, message),
      );
      logCollector.log('agent', 'INFO', '[Channel] orchestrator.sendMessage completed');

      // 获取新增的 assistant 消息作为响应
      const messagesAfter = orchestrator.getMessages();
      const countAfter = messagesAfter.length;
      logCollector.log('agent', 'INFO', `[Channel] Messages after: ${countAfter}, new: ${countAfter - messageCountBefore}`);

      // 只查找新增的消息中的 assistant 回复（找最后一条有内容的，跳过工具调用消息）
      const newMessages = messagesAfter.slice(messageCountBefore);
      const assistantMessages = newMessages.filter(m => m.role === 'assistant' && m.content?.trim());
      const lastAssistantMessage = assistantMessages[assistantMessages.length - 1];

      if (lastAssistantMessage) {
        fullResponse = lastAssistantMessage.content;
        logCollector.log('agent', 'INFO', `[Channel] Found response: ${fullResponse.substring(0, 100)}...`);
      } else {
        logCollector.log('agent', 'WARN', `[Channel] No assistant message with content found in ${newMessages.length} new messages`);
      }

      // 发送响应
      logCollector.log('agent', 'INFO', `[Channel] Sending response (length: ${fullResponse.length})`);
      await this.stopTyping(responseCallback);
      if (fullResponse) {
        const result = await responseCallback.sendText(fullResponse);
        logCollector.log('agent', 'INFO', `[Channel] Response sent: success=${result.success}, error=${result.error || 'none'}`);
      } else {
        const result = await responseCallback.sendText('处理完成，但没有生成响应。');
        logCollector.log('agent', 'INFO', `[Channel] Default response sent: success=${result.success}`);
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      const { summary, retryHint } = summarizeUserFacingError(error, { surface: 'channel_reply' });
      const channelSummary = summarizeChannelError(error).message;
      logCollector.log('agent', 'ERROR', `[Channel] Error: ${errorMsg}`);
      await responseCallback.sendText(`处理失败: ${summary || channelSummary}${retryHint ? `\n${retryHint}` : ''}`);
    } finally {
      await this.stopTyping(responseCallback);
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
        case 'message_delta':
          if (event.data.text) {
            await safeWrite(`data: ${JSON.stringify({
              type: event.data.path === 'reasoning' ? 'stream_reasoning' : 'stream_chunk',
              content: event.data.text,
            })}\n\n`);
          }
          break;
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
      const { summary } = summarizeUserFacingError(error, { surface: 'http_api' });
      logCollector.log('agent', 'ERROR', `[Channel] Streaming error: ${errorMsg}`);
      if (!res.writableEnded && !clientDisconnected) {
        await safeWrite(`data: ${JSON.stringify({ type: 'error', error: summary })}\n\n`);
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
      await this.channelManager.sendErrorResponse(accountId, message, errorMessage);
    } catch (e) {
      logger.error('Failed to send error response', { error: e });
    }
  }

  private getIngressParts(msg: IngressMessage): IngressMessagePart[] {
    if (msg.parts?.length) return msg.parts;
    return [{
      messageId: typeof msg.metadata?.messageId === 'string' ? msg.metadata.messageId : undefined,
      content: msg.content,
      timestamp: msg.timestamp,
      metadata: msg.metadata,
    }];
  }

  private collectPartAttachments(parts: IngressMessagePart[]): ChannelAttachment[] | undefined {
    const attachments: ChannelAttachment[] = [];
    for (const part of parts) {
      const partAttachments = part.metadata?.attachments;
      if (Array.isArray(partAttachments)) {
        attachments.push(...(partAttachments as ChannelAttachment[]));
      }
    }
    return attachments.length ? attachments : undefined;
  }

  private async enrichChannelMessage(message: ChannelMessage): Promise<{
    content: string;
    attachments?: ChannelAttachment[];
  }> {
    const attachments = message.attachments ? [...message.attachments] : undefined;
    if (!attachments?.length) {
      return { content: message.content, attachments };
    }

    const transcriptBlocks: string[] = [];
    for (const attachment of attachments) {
      if (attachment.type !== 'audio') continue;
      const localPath = attachment.localPath ?? this.pathFromAttachmentUrl(attachment.url);
      const existingTranscript = attachment.metadata?.transcript;
      if (!localPath || typeof existingTranscript === 'string') continue;

      attachment.metadata = {
        ...attachment.metadata,
        transcriptionState: 'transcribing',
      };
      attachment.mediaState = 'transcribing';

      const result = await transcribeAudioFile({
        filePath: localPath,
        sessionId: message.context.chatId,
      });

      if (result.ok && result.text?.trim()) {
        // 转写发生在 ingress 脱敏之后，原始 transcript 含敏感内容(邮箱/卡号/口令)。
        // 注入正文/落库前过同一套 redactor，避免绕过隐私防火墙落本地库或下发模型。
        const safeTranscript = sanitizeChannelText(result.text, 12_000);
        attachment.metadata = {
          ...attachment.metadata,
          transcriptionState: 'ready',
          transcript: safeTranscript,
          transcriptionEngine: result.engine,
        };
        attachment.mediaState = 'ready';
        transcriptBlocks.push(`[语音转写: ${attachment.name}]\n${safeTranscript.trim()}`);
      } else {
        attachment.metadata = {
          ...attachment.metadata,
          transcriptionState: 'failed',
          // 对称应用：失败错误串同样可能含本地路径/provider 报错文本，落库前脱敏。
          transcriptionError: result.error ? sanitizeChannelText(result.error, 2_000) : result.error,
        };
        attachment.mediaState = 'failed';
        transcriptBlocks.push(`[语音转写失败: ${attachment.name}]`);
      }
    }

    const content = transcriptBlocks.length
      ? [message.content, ...transcriptBlocks].filter(Boolean).join('\n\n')
      : message.content;
    return { content, attachments };
  }

  private getSessionKey(accountId: string, message: ChannelMessage): string {
    return `${accountId}:${message.context.chatId}`;
  }

  private async getOrCreateChannelSessionId(
    sessionKey: string,
    accountId: string,
    message: ChannelMessage
  ): Promise<string> {
    const sessionManager = getSessionManager();
    const mappedSessionId = this.channelSessions.get(sessionKey);

    if (mappedSessionId) {
      const existingSession = await sessionManager.getSession(mappedSessionId, 1);
      if (existingSession) {
        return mappedSessionId;
      }
      this.channelSessions.delete(sessionKey);
    }

    const account = this.channelManager.getAccount(accountId);
    const session = await sessionManager.createSession({
      title: this.buildChannelSessionTitle(accountId, message),
      modelConfig: this.getChannelModelConfig(),
      origin: {
        kind: 'channel',
        id: accountId,
        name: message.context.chatName || message.context.chatId,
        metadata: {
          chatId: message.context.chatId,
          channelId: message.channelId,
          channelType: account?.type,
          accountId,
          accountName: account?.name,
          chatType: message.context.chatType,
          chatName: message.context.chatName,
        },
      },
    });

    this.channelSessions.set(sessionKey, session.id);
    logger.info('Created dedicated channel session', {
      sessionKey,
      sessionId: session.id,
      accountId,
      chatId: message.context.chatId,
    });

    return session.id;
  }

  private async getOrCreateChannelOrchestrator(
    sessionKey: string,
    accountId: string,
    message: ChannelMessage
  ): Promise<AgentOrchestrator | null> {
    const taskManager = getTaskManager();
    const sessionId = await this.getOrCreateChannelSessionId(sessionKey, accountId, message);

    const existing = taskManager.getOrchestrator(sessionId);
    if (existing) {
      return existing;
    }

    const session = await getSessionManager().getSession(sessionId);
    if (!session) {
      logger.error('Channel session disappeared before orchestrator creation', {
        sessionKey,
        sessionId,
      });
      this.channelSessions.delete(sessionKey);
      return null;
    }

    taskManager.setSessionContext(sessionId, session.messages);
    const orchestrator = taskManager.getOrCreateCurrentOrchestrator(sessionId);
    if (!orchestrator) {
      return null;
    }

    if (session.workingDirectory?.trim()) {
      orchestrator.setWorkingDirectory(session.workingDirectory);
    }

    return orchestrator;
  }

  private buildChannelSessionTitle(accountId: string, message: ChannelMessage): string {
    const account = this.channelManager.getAccount(accountId);
    const accountLabel = account?.name || account?.type || accountId;
    const chatLabel = message.context.chatName || message.context.chatId;
    return `[Channel] ${accountLabel} · ${chatLabel}`;
  }

  private getChannelModelConfig(): ModelConfig {
    const settings = this.config.configService.getSettings();
    return resolveSessionDefaultModelConfig({
      provider: settings.model?.provider,
      model: settings.model?.model,
      temperature: settings.model?.temperature,
      maxTokens: settings.model?.maxTokens,
    });
  }

  private buildChannelMessageMetadata(accountId: string, message: ChannelMessage): MessageMetadata {
    const account = this.channelManager.getAccount(accountId);
    return {
      channel: {
        platform: account?.type || message.channelId || 'channel',
        accountId,
        accountName: account?.name,
        chatId: message.context.chatId,
        chatType: message.context.chatType,
        chatName: message.context.chatName,
        messageId: message.id,
      },
    };
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
      path: att.localPath ?? this.pathFromAttachmentUrl(att.url),
      mediaState: att.mediaState,
      metadata: att.metadata,
    }));
  }

  private pathFromAttachmentUrl(url: string | undefined): string | undefined {
    if (!url) return undefined;
    if (url.startsWith('http://') || url.startsWith('https://') || url.startsWith('/')) {
      return url;
    }
    return undefined;
  }

  /**
   * 获取附件分类
   */
  private getAttachmentCategory(att: ChannelAttachment): AttachmentCategory {
    if (att.type === 'image') return 'image';
    if (att.type === 'audio' || att.mimeType?.startsWith('audio/')) return 'audio';
    if (att.type === 'video' || att.mimeType?.startsWith('video/')) return 'video';
    if (att.mimeType?.includes('pdf')) return 'pdf';
    if (att.mimeType?.includes('presentation') || att.mimeType?.includes('powerpoint')) return 'presentation';
    if (att.mimeType?.includes('zip') || att.mimeType?.includes('gzip') || att.mimeType?.includes('tar')) return 'archive';
    if (att.mimeType?.includes('text')) return 'text';
    if (att.mimeType?.includes('json') || att.mimeType?.includes('csv')) return 'data';
    return 'other';
  }

  private markMessageProcessing(accountId: string, messageId: string): boolean {
    this.pruneProcessedMessages();
    const key = this.getMessageProcessKey(accountId, messageId);
    if (this.processedMessages.has(key)) {
      return false;
    }
    this.processedMessages.set(key, { status: 'processing', timestamp: Date.now() });
    // 容量上界（WP3-2）：此前仅 24h TTL 无上界，高频入站会无界增长。Map 迭代序 = 插入序，
    // 超界逐出最旧（最旧条目早已过了平台重推窗口，逐出不影响正常去重语义）。
    while (this.processedMessages.size > CHANNEL_INGRESS.PROCESSED_MESSAGES_MAX) {
      const oldest = this.processedMessages.keys().next().value;
      if (oldest === undefined) break;
      this.processedMessages.delete(oldest);
    }
    return true;
  }

  private markMessageCompleted(accountId: string, messageId: string | undefined): void {
    if (!messageId) return;
    this.processedMessages.set(this.getMessageProcessKey(accountId, messageId), {
      status: 'completed',
      timestamp: Date.now(),
    });
  }

  private markMessageFailed(accountId: string, messageId: string | undefined): void {
    if (!messageId) return;
    this.processedMessages.set(this.getMessageProcessKey(accountId, messageId), {
      status: 'failed',
      timestamp: Date.now(),
    });
  }

  private markPartsCompleted(accountId: string, parts: IngressMessagePart[]): void {
    for (const part of parts) {
      this.markMessageCompleted(accountId, part.messageId);
    }
  }

  private markPartsFailed(accountId: string, parts: IngressMessagePart[]): void {
    for (const part of parts) {
      this.markMessageFailed(accountId, part.messageId);
    }
  }

  private getMessageProcessKey(accountId: string, messageId: string): string {
    return `${accountId}:${messageId}`;
  }

  private pruneProcessedMessages(): void {
    const now = Date.now();
    for (const [key, entry] of this.processedMessages) {
      if (now - entry.timestamp > this.processedMessageTtlMs) {
        this.processedMessages.delete(key);
      }
    }
  }

  private async startTyping(callback: ChannelResponseCallback): Promise<void> {
    try {
      await callback.startTyping?.();
    } catch (error) {
      logger.debug('Channel typing start failed', { error });
    }
  }

  private async stopTyping(callback: ChannelResponseCallback): Promise<void> {
    try {
      await callback.stopTyping?.();
    } catch (error) {
      logger.debug('Channel typing stop failed', { error });
    }
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
