// ============================================================================
// RealtimeChannel - WebSocket 实时通信通道
// 用于本地客户端和云端之间的双向实时通信
// ============================================================================

import { EventEmitter } from 'events';
import WebSocket from 'ws';
import { WEBSOCKET } from '../../shared/constants';

// ============================================================================
// 类型定义
// ============================================================================

export type MessageType =
  | 'task:start'
  | 'task:progress'
  | 'task:chunk'
  | 'task:complete'
  | 'task:error'
  | 'task:cancel'
  | 'sync:request'
  | 'sync:response'
  | 'heartbeat'
  | 'ack';

export interface ChannelMessage {
  id: string;
  type: MessageType;
  taskId?: string;
  payload: unknown;
  timestamp: number;
  sequence: number;
}

export interface ChannelConfig {
  url: string;
  authToken?: string;
  reconnectAttempts: number;
  reconnectDelay: number;
  heartbeatInterval: number;
  messageTimeout: number;
}

export type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'reconnecting';

export interface PendingMessage {
  message: ChannelMessage;
  resolve: (ack: ChannelMessage) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

const DEFAULT_CONFIG: ChannelConfig = {
  url: process.env.CLOUD_WS_ENDPOINT || 'wss://code-agent-beta.vercel.app/ws',
  reconnectAttempts: WEBSOCKET.MAX_RECONNECTS,
  reconnectDelay: WEBSOCKET.RECONNECT_DELAY,
  heartbeatInterval: WEBSOCKET.HEARTBEAT_INTERVAL,
  messageTimeout: WEBSOCKET.MESSAGE_TIMEOUT,
};

// ============================================================================
// RealtimeChannel 类
// ============================================================================

export class RealtimeChannel extends EventEmitter {
  private config: ChannelConfig;
  private ws: WebSocket | null = null;
  private state: ConnectionState = 'disconnected';
  private reconnectCount = 0;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private sequence = 0;
  private pendingMessages: Map<string, PendingMessage> = new Map();
  private messageBuffer: ChannelMessage[] = [];
  private lastReceivedSequence = -1;

  constructor(config: Partial<ChannelConfig> = {}) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  // --------------------------------------------------------------------------
  // 连接管理
  // --------------------------------------------------------------------------

  /**
   * 建立连接
   */
  async connect(): Promise<void> {
    if (this.state === 'connected' || this.state === 'connecting') {
      return;
    }

    this.state = 'connecting';
    this.emit('state:change', this.state);

    return new Promise((resolve, reject) => {
      try {
        const url = new URL(this.config.url);
        if (this.config.authToken) {
          url.searchParams.set('token', this.config.authToken);
        }

        this.ws = new WebSocket(url.toString());

        this.ws.on('open', () => {
          this.state = 'connected';
          this.reconnectCount = 0;
          this.startHeartbeat();
          this.flushMessageBuffer();
          this.emit('state:change', this.state);
          this.emit('connected');
          resolve();
        });

        this.ws.on('message', (data: WebSocket.Data) => {
          this.handleMessage(data);
        });

        this.ws.on('close', (code, reason) => {
          this.handleClose(code, reason.toString());
        });

        this.ws.on('error', (error) => {
          this.handleError(error);
          if (this.state === 'connecting') {
            reject(error);
          }
        });
      } catch (error) {
        this.state = 'disconnected';
        this.emit('state:change', this.state);
        reject(error);
      }
    });
  }

  /**
   * 断开连接
   */
  disconnect(): void {
    this.stopHeartbeat();
    this.state = 'disconnected';
    this.emit('state:change', this.state);

    if (this.ws) {
      this.ws.close(WEBSOCKET.CLOSE_CODE_NORMAL, 'Client disconnect');
      this.ws = null;
    }

    // 拒绝所有待处理的消息
    for (const [id, pending] of this.pendingMessages) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Connection closed'));
      this.pendingMessages.delete(id);
    }

    this.emit('disconnected');
  }

  /**
   * 重连
   */
  private async reconnect(): Promise<void> {
    if (this.reconnectCount >= this.config.reconnectAttempts) {
      this.emit('reconnect:failed', 'Max reconnect attempts reached');
      return;
    }

    this.state = 'reconnecting';
    this.emit('state:change', this.state);
    this.reconnectCount++;

    const delay = this.config.reconnectDelay * Math.pow(2, this.reconnectCount - 1);
    this.emit('reconnecting', { attempt: this.reconnectCount, delay });

    await this.sleep(delay);

    try {
      await this.connect();
    } catch (error) {
      // 连接失败，继续重试
      this.reconnect();
    }
  }

  // --------------------------------------------------------------------------
  // 消息发送
  // --------------------------------------------------------------------------

  /**
   * 发送消息（带确认）
   */
  async send(type: MessageType, payload: unknown, taskId?: string): Promise<ChannelMessage> {
    const message = this.createMessage(type, payload, taskId);

    if (this.state !== 'connected') {
      // 缓存消息等待重连
      this.messageBuffer.push(message);
      return message;
    }

    return this.sendWithAck(message);
  }

  /**
   * 发送消息（不等待确认）
   */
  sendNoAck(type: MessageType, payload: unknown, taskId?: string): void {
    const message = this.createMessage(type, payload, taskId);

    if (this.state !== 'connected') {
      this.messageBuffer.push(message);
      return;
    }

    this.ws?.send(JSON.stringify(message));
  }

  /**
   * 发送带确认的消息
   */
  private sendWithAck(message: ChannelMessage): Promise<ChannelMessage> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingMessages.delete(message.id);
        reject(new Error(`Message ${message.id} timeout`));
      }, this.config.messageTimeout);

      this.pendingMessages.set(message.id, { message, resolve, reject, timer });
      this.ws?.send(JSON.stringify(message));
    });
  }

  /**
   * 创建消息
   */
  private createMessage(type: MessageType, payload: unknown, taskId?: string): ChannelMessage {
    return {
      id: `msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      type,
      taskId,
      payload,
      timestamp: Date.now(),
      sequence: this.sequence++,
    };
  }

  /**
   * 发送缓存的消息
   */
  private flushMessageBuffer(): void {
    while (this.messageBuffer.length > 0) {
      const message = this.messageBuffer.shift()!;
      this.ws?.send(JSON.stringify(message));
    }
  }

  // --------------------------------------------------------------------------
  // 消息接收
  // --------------------------------------------------------------------------

  /**
   * 处理接收到的消息
   */
  private handleMessage(data: WebSocket.Data): void {
    try {
      const message: ChannelMessage = JSON.parse(data.toString());

      // 处理确认消息
      if (message.type === 'ack') {
        this.handleAck(message);
        return;
      }

      // 处理心跳
      if (message.type === 'heartbeat') {
        this.sendNoAck('ack', { messageId: message.id });
        return;
      }

      // 检查消息顺序
      if (message.sequence <= this.lastReceivedSequence) {
        // 重复消息，忽略
        return;
      }
      this.lastReceivedSequence = message.sequence;

      // 发送确认
      this.sendNoAck('ack', { messageId: message.id });

      // 触发消息事件
      this.emit('message', message);
      this.emit(`message:${message.type}`, message);

      if (message.taskId) {
        this.emit(`task:${message.taskId}:${message.type}`, message);
      }
    } catch (error) {
      this.emit('error', new Error(`Failed to parse message: ${error}`));
    }
  }

  /**
   * 处理确认消息
   */
  private handleAck(message: ChannelMessage): void {
    const payload = message.payload as { messageId: string };
    const pending = this.pendingMessages.get(payload.messageId);

    if (pending) {
      clearTimeout(pending.timer);
      this.pendingMessages.delete(payload.messageId);
      pending.resolve(message);
    }
  }

  // --------------------------------------------------------------------------
  // 错误处理
  // --------------------------------------------------------------------------

  /**
   * 处理连接关闭
   */
  private handleClose(code: number, reason: string): void {
    this.stopHeartbeat();
    this.ws = null;

    if (this.state === 'disconnected') {
      // 主动断开，不重连
      return;
    }

    this.emit('close', { code, reason });

    // 尝试重连
    if (code !== WEBSOCKET.CLOSE_CODE_NORMAL) {
      this.reconnect();
    }
  }

  /**
   * 处理错误
   */
  private handleError(error: Error): void {
    this.emit('error', error);
  }

  // --------------------------------------------------------------------------
  // 心跳
  // --------------------------------------------------------------------------

  /**
   * 启动心跳
   */
  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      this.sendNoAck('heartbeat', { timestamp: Date.now() });
    }, this.config.heartbeatInterval);
  }

  /**
   * 停止心跳
   */
  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  // --------------------------------------------------------------------------
  // 任务相关快捷方法
  // --------------------------------------------------------------------------

  /**
   * 发送任务开始
   */
  async sendTaskStart(taskId: string, payload: unknown): Promise<void> {
    await this.send('task:start', payload, taskId);
  }

  /**
   * 发送任务进度
   */
  sendTaskProgress(taskId: string, progress: number, currentStep?: string): void {
    this.sendNoAck('task:progress', { progress, currentStep }, taskId);
  }

  /**
   * 发送任务输出块
   */
  sendTaskChunk(taskId: string, chunk: string, chunkIndex: number): void {
    this.sendNoAck('task:chunk', { chunk, chunkIndex }, taskId);
  }

  /**
   * 发送任务完成
   */
  async sendTaskComplete(taskId: string, result: unknown): Promise<void> {
    await this.send('task:complete', result, taskId);
  }

  /**
   * 发送任务错误
   */
  async sendTaskError(taskId: string, error: string): Promise<void> {
    await this.send('task:error', { error }, taskId);
  }

  /**
   * 取消任务
   */
  async cancelTask(taskId: string): Promise<void> {
    await this.send('task:cancel', {}, taskId);
  }

  // --------------------------------------------------------------------------
  // 状态查询
  // --------------------------------------------------------------------------

  /**
   * 获取连接状态
   */
  getState(): ConnectionState {
    return this.state;
  }

  /**
   * 是否已连接
   */
  isConnected(): boolean {
    return this.state === 'connected';
  }

  /**
   * 获取待处理消息数
   */
  getPendingCount(): number {
    return this.pendingMessages.size;
  }

  /**
   * 获取缓存消息数
   */
  getBufferedCount(): number {
    return this.messageBuffer.length;
  }

  /**
   * 设置认证令牌
   */
  setAuthToken(token: string): void {
    this.config.authToken = token;
  }

  // --------------------------------------------------------------------------
  // 辅助方法
  // --------------------------------------------------------------------------

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * 清理资源
   */
  dispose(): void {
    this.disconnect();
    this.removeAllListeners();
  }
}

// ============================================================================
// 单例实例
// ============================================================================

let channelInstance: RealtimeChannel | null = null;

export function getRealtimeChannel(): RealtimeChannel {
  if (!channelInstance) {
    channelInstance = new RealtimeChannel();
  }
  return channelInstance;
}

export function initRealtimeChannel(config: Partial<ChannelConfig>): RealtimeChannel {
  channelInstance = new RealtimeChannel(config);
  return channelInstance;
}
