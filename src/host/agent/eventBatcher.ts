// ============================================================================
// Event Batcher - 高频 IPC 事件批处理器
// 将多个事件合并为一次 IPC 调用，减少渲染进程压力
//
// 事件分类（BATCHABLE / IMMEDIATE）已迁至 src/host/protocol/events.ts，
// 本文件专注于批处理调度策略。下一阶段（P0-5+）整个 batcher 应纳入 protocol 层的
// Event Bus，成为 Submission/Event 模式的实现之一。
// ============================================================================

import {
  BATCHABLE_EVENT_TYPES,
  IMMEDIATE_EVENT_TYPES,
  type AgentEvent,
} from '../protocol/events';

export interface EventBatcherConfig<TEvent extends AgentEvent = AgentEvent> {
  /** 批处理间隔（毫秒），默认 16ms（约 60fps） */
  flushInterval?: number;
  /** 最大批量大小，超过此值立即刷新 */
  maxBatchSize?: number;
  /** 事件发送回调 */
  onFlush: (events: TEvent[]) => void;
}

type StreamTextEventType = 'message_delta' | 'stream_chunk' | 'stream_reasoning';

interface EventEnvelopeMeta {
  sessionId?: string;
  seq?: number;
}

interface StreamTextBuffer {
  type: StreamTextEventType;
  content: string;
  isMeta?: boolean;
  role?: 'assistant';
  path?: 'content' | 'reasoning';
  op?: 'append';
  turnId?: string;
  messageId?: string;
  deltaSeq?: number;
  parentToolUseId?: string;
  meta: EventEnvelopeMeta;
}

interface StreamToolCallDeltaBuffer {
  index?: number;
  name?: string;
  argumentsDelta: string;
  turnId?: string;
  parentToolUseId?: string;
  meta: EventEnvelopeMeta;
}

function getEventEnvelopeMeta(event: AgentEvent): EventEnvelopeMeta {
  const envelope = event as AgentEvent & EventEnvelopeMeta;
  return {
    ...(typeof envelope.sessionId === 'string' ? { sessionId: envelope.sessionId } : {}),
    ...(typeof envelope.seq === 'number' ? { seq: envelope.seq } : {}),
  };
}

function hasEnvelopeMeta(meta: EventEnvelopeMeta): boolean {
  return meta.sessionId !== undefined || meta.seq !== undefined;
}

function mergeLatestEnvelopeMeta(target: EventEnvelopeMeta, source: EventEnvelopeMeta): EventEnvelopeMeta {
  return {
    ...(target.sessionId !== undefined ? { sessionId: target.sessionId } : {}),
    ...(source.seq !== undefined ? { seq: source.seq } : target.seq !== undefined ? { seq: target.seq } : {}),
  };
}

/**
 * 事件批处理器
 *
 * 性能优化策略：
 * 1. 高频事件（stream_chunk）累积后批量发送
 * 2. 关键事件（message, error）立即发送
 * 3. 使用 requestAnimationFrame 节奏或固定间隔
 */
export class EventBatcher<TEvent extends AgentEvent = AgentEvent> {
  private batch: TEvent[] = [];
  private timer: NodeJS.Timeout | null = null;
  private flushInterval: number;
  private maxBatchSize: number;
  private onFlush: (events: TEvent[]) => void;
  private isDestroyed: boolean = false;

  private streamTextBuffer: StreamTextBuffer | null = null;
  private streamToolCallDeltaBuffer: StreamToolCallDeltaBuffer | null = null;

  constructor(config: EventBatcherConfig<TEvent>) {
    this.flushInterval = config.flushInterval ?? 16; // 60fps
    this.maxBatchSize = config.maxBatchSize ?? 50;
    this.onFlush = config.onFlush;
  }

  /**
   * 添加事件到批处理队列
   */
  emit(event: TEvent): void {
    if (this.isDestroyed) return;

    // 关键事件立即发送（先刷新现有批次）
    if (IMMEDIATE_EVENT_TYPES.has(event.type) || !BATCHABLE_EVENT_TYPES.has(event.type)) {
      this.flush();
      this.onFlush([event]);
      return;
    }

    // message_delta / stream_chunk / stream_reasoning 特殊处理：合并连续的文本 delta
    if (
      event.type === 'message_delta' ||
      event.type === 'stream_chunk' ||
      event.type === 'stream_reasoning'
    ) {
      this.flushToolCallDelta();
      const data = event.data as {
        content?: string;
        text?: string;
        role?: 'assistant';
        path?: 'content' | 'reasoning';
        op?: 'append' | 'replace';
        turnId?: string;
        messageId?: string;
        deltaSeq?: number;
        parentToolUseId?: string;
        isMeta?: boolean;
      };
      const content = event.type === 'message_delta' ? data.text : data.content;
      const meta = getEventEnvelopeMeta(event);
      if (event.type === 'message_delta' && data.op === 'replace') {
        this.flushStreamText();
        this.batch.push(event);
        this.scheduleFlush();
        return;
      }
      if (content) {
        if (
          this.streamTextBuffer &&
          (
            this.streamTextBuffer.type !== event.type ||
            this.streamTextBuffer.path !== data.path ||
            this.streamTextBuffer.turnId !== data.turnId ||
            this.streamTextBuffer.messageId !== data.messageId ||
            this.streamTextBuffer.parentToolUseId !== data.parentToolUseId ||
            this.streamTextBuffer.isMeta !== data.isMeta ||
            this.streamTextBuffer.meta.sessionId !== meta.sessionId
          )
        ) {
          this.flushStreamText();
        }

        if (!this.streamTextBuffer) {
          this.streamTextBuffer = {
            type: event.type,
            content: '',
            role: data.role,
            path: data.path,
            op: event.type === 'message_delta' ? 'append' : undefined,
            turnId: data.turnId,
            messageId: data.messageId,
            deltaSeq: data.deltaSeq,
            parentToolUseId: data.parentToolUseId,
            isMeta: data.isMeta,
            meta,
          };
        }
        this.streamTextBuffer.content += content;
        if (data.deltaSeq !== undefined) {
          this.streamTextBuffer.deltaSeq = data.deltaSeq;
        }
        this.streamTextBuffer.meta = mergeLatestEnvelopeMeta(this.streamTextBuffer.meta, meta);
        this.scheduleFlush();
        return;
      }
    }

    // stream_tool_call_delta 特殊处理：合并同一 pending tool call 的连续参数片段
    if (event.type === 'stream_tool_call_delta') {
      this.flushStreamText();
      const data = event.data as {
        index?: number;
        name?: string;
        argumentsDelta?: string;
        turnId?: string;
        parentToolUseId?: string;
      };
      const meta = getEventEnvelopeMeta(event);

      if (data.name || data.argumentsDelta) {
        if (
          this.streamToolCallDeltaBuffer &&
          (
            this.streamToolCallDeltaBuffer.index !== data.index ||
            this.streamToolCallDeltaBuffer.turnId !== data.turnId ||
            this.streamToolCallDeltaBuffer.parentToolUseId !== data.parentToolUseId ||
            this.streamToolCallDeltaBuffer.meta.sessionId !== meta.sessionId ||
            (
              this.streamToolCallDeltaBuffer.name !== undefined &&
              data.name !== undefined &&
              this.streamToolCallDeltaBuffer.name !== data.name
            )
          )
        ) {
          this.flushToolCallDelta();
        }

        if (!this.streamToolCallDeltaBuffer) {
          this.streamToolCallDeltaBuffer = {
            index: data.index,
            name: data.name,
            argumentsDelta: '',
            turnId: data.turnId,
            parentToolUseId: data.parentToolUseId,
            meta,
          };
        }
        if (!this.streamToolCallDeltaBuffer.name && data.name) {
          this.streamToolCallDeltaBuffer.name = data.name;
        }
        if (data.argumentsDelta) {
          this.streamToolCallDeltaBuffer.argumentsDelta += data.argumentsDelta;
        }
        this.streamToolCallDeltaBuffer.meta = mergeLatestEnvelopeMeta(
          this.streamToolCallDeltaBuffer.meta,
          meta,
        );
        this.scheduleFlush();
        return;
      }
    }

    // 其他可批处理事件，先落下已有文本缓冲，保持事件顺序
    this.flushStreamText();
    this.flushToolCallDelta();
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
   * 刷新流式文本缓冲
   */
  private flushStreamText(): void {
    if (this.streamTextBuffer && this.streamTextBuffer.content.length > 0) {
      const buffered = this.streamTextBuffer;
      if (buffered.type === 'message_delta') {
        this.batch.push({
          type: 'message_delta',
          data: {
            role: buffered.role ?? 'assistant',
            path: buffered.path ?? 'content',
            op: buffered.op ?? 'append',
            text: buffered.content,
            turnId: buffered.turnId,
            messageId: buffered.messageId,
            ...(buffered.deltaSeq !== undefined ? { deltaSeq: buffered.deltaSeq } : {}),
            parentToolUseId: buffered.parentToolUseId,
            ...(buffered.isMeta ? { isMeta: true } : {}),
          },
          ...(hasEnvelopeMeta(buffered.meta) ? buffered.meta : {}),
        } as TEvent);
      } else {
        this.batch.push({
          type: buffered.type,
          data: {
            content: buffered.content,
            turnId: buffered.turnId,
            parentToolUseId: buffered.parentToolUseId,
            ...(buffered.isMeta ? { isMeta: true } : {}),
          },
          ...(hasEnvelopeMeta(buffered.meta) ? buffered.meta : {}),
        } as TEvent);
      }
      this.streamTextBuffer = null;
    }
  }

  /**
   * 刷新工具参数流缓冲
   */
  private flushToolCallDelta(): void {
    if (!this.streamToolCallDeltaBuffer) return;

    const buffered = this.streamToolCallDeltaBuffer;
    const data: {
      index?: number;
      name?: string;
      argumentsDelta?: string;
      turnId?: string;
      parentToolUseId?: string;
    } = {};
    if (buffered.index !== undefined) data.index = buffered.index;
    if (buffered.name !== undefined) data.name = buffered.name;
    if (buffered.argumentsDelta.length > 0) data.argumentsDelta = buffered.argumentsDelta;
    if (buffered.turnId !== undefined) data.turnId = buffered.turnId;
    if (buffered.parentToolUseId !== undefined) data.parentToolUseId = buffered.parentToolUseId;

    this.batch.push({
      type: 'stream_tool_call_delta',
      data,
      ...(hasEnvelopeMeta(buffered.meta) ? buffered.meta : {}),
    } as TEvent);
    this.streamToolCallDeltaBuffer = null;
  }

  /**
   * 立即刷新所有待发送事件
   */
  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    // 先刷新流式文本
    this.flushStreamText();
    this.flushToolCallDelta();

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
  config?: Partial<Omit<EventBatcherConfig, 'onFlush'>>
): {
  emit: (event: AgentEvent) => void;
  flush: () => void;
  destroy: () => void;
} {
  const batcher = new EventBatcher({
    ...config,
    onFlush: (events) => {
      events.forEach(originalOnEvent);
    },
  });

  return {
    emit: (event: AgentEvent) => batcher.emit(event),
    flush: () => batcher.flush(),
    destroy: () => batcher.destroy(),
  };
}
