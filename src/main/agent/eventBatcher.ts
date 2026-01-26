// ============================================================================
// Event Batcher - 高频 IPC 事件批处理器
// 将多个事件合并为一次 IPC 调用，减少渲染进程压力
// ============================================================================

import type { AgentEvent } from '../../shared/types';

// 可批处理的高频事件类型
const BATCHABLE_EVENTS = new Set([
  'stream_chunk',
  'stream_tool_call_delta',
]);

// 需要立即发送的关键事件（不参与批处理）
const IMMEDIATE_EVENTS = new Set([
  'message',
  'error',
  'permission_request',
  'agent_complete',
  'turn_start',
  'turn_end',
  'tool_call_start',
  'tool_call_end',
  'budget_exceeded',
]);

export interface EventBatcherConfig {
  /** 批处理间隔（毫秒），默认 16ms（约 60fps） */
  flushInterval?: number;
  /** 最大批量大小，超过此值立即刷新 */
  maxBatchSize?: number;
  /** 事件发送回调 */
  onFlush: (events: AgentEvent[]) => void;
}

/**
 * 事件批处理器
 *
 * 性能优化策略：
 * 1. 高频事件（stream_chunk）累积后批量发送
 * 2. 关键事件（message, error）立即发送
 * 3. 使用 requestAnimationFrame 节奏或固定间隔
 */
export class EventBatcher {
  private batch: AgentEvent[] = [];
  private timer: NodeJS.Timeout | null = null;
  private flushInterval: number;
  private maxBatchSize: number;
  private onFlush: (events: AgentEvent[]) => void;
  private isDestroyed: boolean = false;

  // 流式 chunk 合并缓冲
  private streamChunkBuffer: string = '';
  private lastStreamTurnId: string | undefined;

  constructor(config: EventBatcherConfig) {
    this.flushInterval = config.flushInterval ?? 16; // 60fps
    this.maxBatchSize = config.maxBatchSize ?? 50;
    this.onFlush = config.onFlush;
  }

  /**
   * 添加事件到批处理队列
   */
  emit(event: AgentEvent): void {
    if (this.isDestroyed) return;

    // 关键事件立即发送（先刷新现有批次）
    if (IMMEDIATE_EVENTS.has(event.type)) {
      this.flush();
      this.onFlush([event]);
      return;
    }

    // stream_chunk 特殊处理：合并连续的 chunk
    if (event.type === 'stream_chunk') {
      const data = event.data as { content: string | undefined; turnId?: string };
      if (data.content) {
        // 如果 turnId 变了，先刷新之前的
        if (this.lastStreamTurnId !== undefined && this.lastStreamTurnId !== data.turnId) {
          this.flushStreamChunks();
        }
        this.streamChunkBuffer += data.content;
        this.lastStreamTurnId = data.turnId;
        this.scheduleFlush();
        return;
      }
    }

    // 其他可批处理事件
    this.batch.push(event);

    // 批量超限立即刷新
    if (this.batch.length >= this.maxBatchSize) {
      this.flush();
      return;
    }

    this.scheduleFlush();
  }

  /**
   * 调度刷新
   */
  private scheduleFlush(): void {
    if (this.timer) return;

    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, this.flushInterval);
  }

  /**
   * 刷新流式 chunk 缓冲
   */
  private flushStreamChunks(): void {
    if (this.streamChunkBuffer.length > 0) {
      this.batch.push({
        type: 'stream_chunk',
        data: {
          content: this.streamChunkBuffer,
          turnId: this.lastStreamTurnId,
        },
      });
      this.streamChunkBuffer = '';
    }
  }

  /**
   * 立即刷新所有待发送事件
   */
  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    // 先刷新流式 chunk
    this.flushStreamChunks();

    if (this.batch.length === 0) return;

    const events = this.batch;
    this.batch = [];
    this.onFlush(events);
  }

  /**
   * 销毁批处理器
   */
  destroy(): void {
    this.isDestroyed = true;
    this.flush();
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}

/**
 * 创建一个包装了批处理的 onEvent 函数
 */
export function createBatchedEventEmitter(
  originalOnEvent: (event: AgentEvent) => void,
  config?: Partial<EventBatcherConfig>
): {
  emit: (event: AgentEvent) => void;
  flush: () => void;
  destroy: () => void;
} {
  const batcher = new EventBatcher({
    ...config,
    onFlush: (events) => {
      // 批量事件以数组形式发送，渲染进程需要支持
      if (events.length === 1) {
        originalOnEvent(events[0]);
      } else {
        // 发送批量事件
        originalOnEvent({
          type: 'batch' as any,
          data: events,
        } as any);
      }
    },
  });

  return {
    emit: (event: AgentEvent) => batcher.emit(event),
    flush: () => batcher.flush(),
    destroy: () => batcher.destroy(),
  };
}
