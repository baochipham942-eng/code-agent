// ============================================================================
// HTTP API Channel - REST API 通道实现
// ============================================================================

import express, { Express, Request, Response, NextFunction } from 'express';
import http from 'http';
import { v4 as uuidv4 } from 'uuid';
import {
  BaseChannelPlugin,
  type ChannelResponseCallback,
} from '../channelInterface';
import type {
  ChannelMeta,
  ChannelMessage,
  ChannelAccountConfig,
  HttpApiChannelConfig,
  SendMessageOptions,
  SendMessageResult,
  ChannelCapabilities,
} from '../../../shared/types/channel';
import { createLogger } from '../../services/infra/logger';
import { registerCaptureRoutes } from './captureRoutes';

const logger = createLogger('ApiChannel');

/**
 * HTTP API 通道能力
 */
const API_CHANNEL_CAPABILITIES: ChannelCapabilities = {
  streaming: true,
  editMessage: false,
  deleteMessage: false,
  addReaction: false,
  richText: true,
  attachments: true,
  images: true,
  mentions: false,
  threads: false,
  maxMessageLength: 100000,
};

/**
 * 同步消息请求体
 */
interface SyncMessageRequest {
  /** 消息内容 */
  message: string;
  /** 会话 ID (可选，用于多轮对话) */
  sessionId?: string;
  /** 附件 (base64 编码) */
  attachments?: Array<{
    type: 'image' | 'file';
    name: string;
    mimeType: string;
    data: string;
  }>;
  /** 发送者信息 (可选) */
  sender?: {
    id: string;
    name: string;
  };
}

/**
 * 同步消息响应体
 */
interface SyncMessageResponse {
  /** 是否成功 */
  success: boolean;
  /** 响应内容 */
  response?: string;
  /** 会话 ID */
  sessionId?: string;
  /** 错误信息 */
  error?: string;
}

/**
 * 待处理请求
 */
interface PendingRequest {
  resolve: (response: string) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

/**
 * HTTP API 通道实现
 */
export class ApiChannel extends BaseChannelPlugin {
  readonly meta: ChannelMeta;
  private app: Express | null = null;
  private server: http.Server | null = null;
  private apiConfig: HttpApiChannelConfig | null = null;

  // 请求-响应配对
  private pendingRequests: Map<string, PendingRequest> = new Map();
  // 请求超时时间 (5 分钟)
  private readonly REQUEST_TIMEOUT = 5 * 60 * 1000;

  constructor(accountId: string) {
    super(accountId);
    this.meta = {
      id: accountId,
      type: 'http-api',
      name: 'HTTP API',
      description: 'REST API 通道，支持同步和流式消息',
      capabilities: API_CHANNEL_CAPABILITIES,
    };
  }

  async initialize(config: ChannelAccountConfig): Promise<void> {
    if (config.type !== 'http-api') {
      throw new Error('Invalid config type for ApiChannel');
    }
    this.apiConfig = config as HttpApiChannelConfig;
    this.config = config;
    logger.info('ApiChannel initialized', { port: this.apiConfig.port });
  }

  async connect(): Promise<void> {
    if (!this.apiConfig) {
      throw new Error('ApiChannel not initialized');
    }

    this.setStatus('connecting');

    try {
      this.app = express();
      this.setupMiddleware();
      this.setupRoutes();

      this.server = await new Promise<http.Server>((resolve, reject) => {
        const host = this.apiConfig!.host || '127.0.0.1';
        const server = this.app!.listen(this.apiConfig!.port, host, () => {
          logger.info(`API Channel listening on ${host}:${this.apiConfig!.port}`);
          resolve(server);
        });
        server.on('error', reject);
      });

      this.setStatus('connected');
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      this.setStatus('error', message);
      throw error;
    }
  }

  async disconnect(): Promise<void> {
    if (this.server) {
      await new Promise<void>((resolve, reject) => {
        this.server!.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      });
      this.server = null;
    }
    this.app = null;
    this.setStatus('disconnected');
    logger.info('ApiChannel disconnected');
  }

  async destroy(): Promise<void> {
    // 清理所有待处理请求
    for (const [requestId, pending] of this.pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Channel destroyed'));
    }
    this.pendingRequests.clear();

    await this.disconnect();
  }

  async sendMessage(options: SendMessageOptions): Promise<SendMessageResult> {
    // API Channel 的发送消息用于响应请求
    // 实际实现通过 resolveRequest 完成
    logger.debug('sendMessage called', { chatId: options.chatId });

    const pending = this.pendingRequests.get(options.chatId);
    if (pending) {
      clearTimeout(pending.timer);
      pending.resolve(options.content);
      this.pendingRequests.delete(options.chatId);
      return { success: true, messageId: uuidv4() };
    }

    return { success: false, error: 'No pending request for this chat' };
  }

  /**
   * 解析请求并返回响应
   * 用于 Agent 处理完成后回调
   */
  resolveRequest(requestId: string, response: string): boolean {
    const pending = this.pendingRequests.get(requestId);
    if (!pending) {
      logger.warn('No pending request found', { requestId });
      return false;
    }

    clearTimeout(pending.timer);
    pending.resolve(response);
    this.pendingRequests.delete(requestId);
    return true;
  }

  /**
   * 请求发生错误
   */
  rejectRequest(requestId: string, error: Error): boolean {
    const pending = this.pendingRequests.get(requestId);
    if (!pending) {
      return false;
    }

    clearTimeout(pending.timer);
    pending.reject(error);
    this.pendingRequests.delete(requestId);
    return true;
  }

  /**
   * 获取响应回调对象
   */
  getResponseCallback(requestId: string): ChannelResponseCallback {
    return {
      sendText: async (content: string) => {
        const success = this.resolveRequest(requestId, content);
        return { success, messageId: success ? uuidv4() : undefined };
      },
    };
  }

  // ========== Private Methods ==========

  private setupMiddleware(): void {
    if (!this.app || !this.apiConfig) return;

    // JSON body parser
    this.app.use(express.json({ limit: '50mb' }));

    // CORS
    if (this.apiConfig.enableCors) {
      this.app.use((req, res, next) => {
        const origin = req.headers.origin || '*';
        const allowedOrigins = this.apiConfig!.allowedOrigins;

        if (!allowedOrigins || allowedOrigins.length === 0 || allowedOrigins.includes(origin)) {
          res.header('Access-Control-Allow-Origin', origin);
          res.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
          res.header('Access-Control-Allow-Headers', 'Content-Type, X-API-Key');
        }

        if (req.method === 'OPTIONS') {
          res.sendStatus(200);
          return;
        }
        next();
      });
    }

    // API Key 认证
    this.app.use((req: Request, res: Response, next: NextFunction) => {
      // 跳过 health check 和 capture 路由（localhost-only，无需 API Key）
      if (req.path === '/health' || req.path.startsWith('/api/capture')) {
        next();
        return;
      }

      const apiKey = req.headers['x-api-key'] as string;
      if (!apiKey || apiKey !== this.apiConfig!.apiKey) {
        res.status(401).json({ error: 'Invalid API key' });
        return;
      }
      next();
    });
  }

  private setupRoutes(): void {
    if (!this.app) return;

    // Health check
    this.app.get('/health', (_req, res) => {
      res.json({ status: 'ok', channel: 'http-api', accountId: this._accountId });
    });

    // 同步消息端点
    this.app.post('/api/message', async (req: Request, res: Response) => {
      try {
        const body = req.body as SyncMessageRequest;

        if (!body.message || typeof body.message !== 'string') {
          res.status(400).json({ success: false, error: 'Message is required' });
          return;
        }

        const requestId = uuidv4();
        const sessionId = body.sessionId || uuidv4();

        // 创建 ChannelMessage
        const channelMessage: ChannelMessage = {
          id: requestId,
          channelId: this._accountId,
          sender: {
            id: body.sender?.id || 'api-user',
            name: body.sender?.name || 'API User',
          },
          context: {
            chatId: requestId, // 使用 requestId 作为 chatId 用于响应配对
            chatType: 'p2p',
          },
          content: body.message,
          attachments: body.attachments?.map(att => ({
            id: uuidv4(),
            type: att.type,
            name: att.name,
            mimeType: att.mimeType,
            data: att.data,
          })),
          timestamp: Date.now(),
          raw: { sessionId, requestId },
        };

        // 创建 Promise 等待响应
        const responsePromise = new Promise<string>((resolve, reject) => {
          const timer = setTimeout(() => {
            this.pendingRequests.delete(requestId);
            reject(new Error('Request timeout'));
          }, this.REQUEST_TIMEOUT);

          this.pendingRequests.set(requestId, { resolve, reject, timer });
        });

        // 发出消息事件，让 ChannelManager 处理
        this.emit('message', channelMessage);

        // 等待响应
        const response = await responsePromise;

        const result: SyncMessageResponse = {
          success: true,
          response,
          sessionId,
        };
        res.json(result);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        logger.error('Error handling message', { error: message });
        res.status(500).json({ success: false, error: message });
      }
    });

    // 流式消息端点
    this.app.post('/api/message/stream', async (req: Request, res: Response) => {
      try {
        const body = req.body as SyncMessageRequest;

        if (!body.message || typeof body.message !== 'string') {
          res.status(400).json({ success: false, error: 'Message is required' });
          return;
        }

        const requestId = uuidv4();
        const sessionId = body.sessionId || uuidv4();

        // 设置 SSE headers
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');

        // 创建 ChannelMessage
        const channelMessage: ChannelMessage = {
          id: requestId,
          channelId: this._accountId,
          sender: {
            id: body.sender?.id || 'api-user',
            name: body.sender?.name || 'API User',
          },
          context: {
            chatId: requestId,
            chatType: 'p2p',
          },
          content: body.message,
          timestamp: Date.now(),
          raw: { sessionId, requestId, streaming: true, res },
        };

        // 发出消息事件
        this.emit('message', channelMessage);

        // 对于流式响应，我们需要不同的处理方式
        // ChannelManager 会通过 raw.res 直接写入响应
        // 这里只需要等待完成
        const timeout = setTimeout(() => {
          if (!res.writableEnded) {
            res.write(`data: ${JSON.stringify({ error: 'Timeout' })}\n\n`);
            res.end();
          }
        }, this.REQUEST_TIMEOUT);

        req.on('close', () => {
          clearTimeout(timeout);
          // 客户端断开，取消请求
          this.pendingRequests.delete(requestId);
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        logger.error('Error handling stream message', { error: message });
        if (!res.headersSent) {
          res.status(500).json({ success: false, error: message });
        }
      }
    });

    // 获取通道信息
    this.app.get('/api/channel', (_req, res) => {
      res.json({
        id: this._accountId,
        type: 'http-api',
        capabilities: API_CHANNEL_CAPABILITIES,
        status: this._status,
      });
    });

    // 注册采集相关路由（浏览器插件用）
    registerCaptureRoutes(this.app);
  }
}

/**
 * 创建 HTTP API 通道工厂
 */
export function createApiChannelFactory() {
  return (accountId: string) => new ApiChannel(accountId);
}
