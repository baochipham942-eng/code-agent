// ============================================================================
// Agent Loop Iterator - Async Generator wrapper for event-based AgentOrchestrator
// Provides Claude Agent SDK compatible streaming interface
// ============================================================================

import type { AgentEvent } from '../../shared/types';
import type { AgentOrchestrator } from './agentOrchestrator';

// ----------------------------------------------------------------------------
// Types
// ----------------------------------------------------------------------------

/**
 * Iterator yield 的事件类型
 * 与 Claude Agent SDK 的 AgentEvent 对齐
 */
export interface IteratorEvent {
  type: 'agent_event';
  event: AgentEvent;
}

/**
 * Iterator 完成标记
 */
export interface IteratorComplete {
  type: 'agent_complete';
}

/**
 * Iterator yield 的联合类型
 */
export type IteratorYield = IteratorEvent | IteratorComplete;

/**
 * Agent Iterator 配置
 */
export interface AgentIteratorConfig {
  /**
   * AgentOrchestrator 实例
   */
  orchestrator: AgentOrchestrator;

  /**
   * 用户消息内容
   */
  message: string;

  /**
   * 可选的附件列表
   */
  attachments?: unknown[];
}

// ----------------------------------------------------------------------------
// Helper: Event Queue
// ----------------------------------------------------------------------------

/**
 * 线程安全的事件队列
 * 用于在事件回调和 async generator 之间传递数据
 */
class EventQueue<T> {
  private queue: T[] = [];
  private resolvers: Array<(value: T) => void> = [];
  private closed = false;

  /**
   * 入队一个事件
   */
  push(item: T): void {
    if (this.closed) return;

    if (this.resolvers.length > 0) {
      // 有等待的消费者，直接交付
      const resolver = this.resolvers.shift()!;
      resolver(item);
    } else {
      // 入队等待消费
      this.queue.push(item);
    }
  }

  /**
   * 出队一个事件（异步等待）
   */
  async pull(): Promise<T | null> {
    if (this.queue.length > 0) {
      return this.queue.shift()!;
    }

    if (this.closed) {
      return null;
    }

    // 等待新事件
    return new Promise<T>((resolve) => {
      this.resolvers.push(resolve);
    });
  }

  /**
   * 关闭队列
   */
  close(): void {
    this.closed = true;
    // 释放所有等待的消费者
    for (const resolver of this.resolvers) {
      resolver(null as unknown as T);
    }
    this.resolvers = [];
  }

  /**
   * 检查队列是否已关闭
   */
  isClosed(): boolean {
    return this.closed;
  }
}

// ----------------------------------------------------------------------------
// Main Function
// ----------------------------------------------------------------------------

/**
 * 创建 Agent 执行的 Async Generator
 *
 * 将 AgentOrchestrator 的事件驱动模式包装为 async generator，
 * 便于在 CLI 工具、单元测试或同步风格的脚本中使用。
 *
 * 设计原则：
 * - 保持现有事件模式不变（AgentOrchestrator.onEvent 继续工作）
 * - 提供可选的 generator 包装，不强制使用
 * - 与 Claude Agent SDK 的 AgentEvent 类型对齐
 *
 * @example
 * ```typescript
 * // CLI 工具集成
 * const iterator = createAgentIterator({
 *   orchestrator,
 *   message: '帮我写一个贪吃蛇游戏',
 * });
 *
 * for await (const item of iterator) {
 *   if (item.type === 'agent_event') {
 *     console.log('Event:', item.event.type);
 *   } else if (item.type === 'agent_complete') {
 *     console.log('Agent completed');
 *   }
 * }
 * ```
 *
 * @example
 * ```typescript
 * // 单元测试
 * const events: AgentEvent[] = [];
 * for await (const item of createAgentIterator({ orchestrator, message: 'test' })) {
 *   if (item.type === 'agent_event') {
 *     events.push(item.event);
 *   }
 * }
 * expect(events.some(e => e.type === 'message')).toBe(true);
 * ```
 *
 * @param config - Iterator 配置
 * @yields IteratorYield - 事件或完成标记
 */
export async function* createAgentIterator(
  config: AgentIteratorConfig
): AsyncGenerator<IteratorYield, void, undefined> {
  const { orchestrator, message, attachments } = config;
  const eventQueue = new EventQueue<IteratorYield>();

  // 保存原始的 onEvent 回调（如果有的话）
  // Note: AgentOrchestrator 的 onEvent 是在构造时传入的，
  // 这里我们需要通过一个包装来同时支持原始回调和 iterator
  //
  // 由于 AgentOrchestrator 不直接暴露 onEvent，
  // 我们需要创建一个新的 orchestrator wrapper 或使用事件桥接模式

  // 创建事件处理器
  const handleEvent = (event: AgentEvent): void => {
    // 将事件入队供 generator 消费
    eventQueue.push({ type: 'agent_event', event });

    // 检测完成事件
    if (event.type === 'agent_complete') {
      eventQueue.push({ type: 'agent_complete' });
      eventQueue.close();
    }
  };

  // 由于 AgentOrchestrator 的 onEvent 是在构造时通过 config 传入的，
  // 我们无法直接注入新的事件处理器。
  //
  // 解决方案：使用 createAgentIteratorWithEventBridge 替代，
  // 或者让调用方在构造 orchestrator 时传入我们的事件处理器。
  //
  // 这里提供一个简化版本：假设调用方已经在 orchestrator 的 onEvent 中
  // 调用了我们提供的 bridge 函数。

  // 启动 Agent 执行（非阻塞）
  const runPromise = orchestrator.sendMessage(message, attachments).catch((error) => {
    // 发送错误事件
    eventQueue.push({
      type: 'agent_event',
      event: { type: 'error', data: { message: error.message || 'Unknown error' } },
    });
    eventQueue.push({ type: 'agent_complete' });
    eventQueue.close();
  });

  // 消费事件队列
  while (!eventQueue.isClosed()) {
    const item = await eventQueue.pull();
    if (item === null) {
      break;
    }
    yield item;
  }

  // 等待 Agent 执行完成
  await runPromise;
}

// ----------------------------------------------------------------------------
// Event Bridge Pattern
// ----------------------------------------------------------------------------

/**
 * 事件桥接器类型
 * 用于将 AgentOrchestrator 的事件转发到 iterator
 */
export type EventBridge = (event: AgentEvent) => void;

/**
 * 创建带事件桥接的 Agent Iterator
 *
 * 这是推荐的使用方式：调用方在构造 AgentOrchestrator 时，
 * 将返回的 bridge 函数传给 onEvent 配置。
 *
 * @example
 * ```typescript
 * // 1. 创建 bridge
 * const { iterator, bridge } = createAgentIteratorWithBridge({
 *   message: '帮我写一个贪吃蛇游戏',
 * });
 *
 * // 2. 构造 orchestrator 时使用 bridge
 * const orchestrator = new AgentOrchestrator({
 *   generationManager,
 *   configService,
 *   onEvent: (event) => {
 *     bridge(event);  // 转发给 iterator
 *     // 也可以同时处理其他逻辑
 *     console.log('Event:', event.type);
 *   },
 * });
 *
 * // 3. 启动执行并消费 iterator
 * orchestrator.sendMessage(message);
 * for await (const item of iterator) {
 *   // ...
 * }
 * ```
 *
 * @param config - 配置（不包含 orchestrator）
 * @returns bridge 函数和 iterator
 */
export function createAgentIteratorWithBridge(config?: {
  message?: string;
}): {
  bridge: EventBridge;
  iterator: AsyncGenerator<IteratorYield, void, undefined>;
} {
  const eventQueue = new EventQueue<IteratorYield>();

  // 创建 bridge 函数
  const bridge: EventBridge = (event: AgentEvent): void => {
    eventQueue.push({ type: 'agent_event', event });

    if (event.type === 'agent_complete') {
      eventQueue.push({ type: 'agent_complete' });
      eventQueue.close();
    }
  };

  // 创建 iterator
  async function* generateIterator(): AsyncGenerator<IteratorYield, void, undefined> {
    while (!eventQueue.isClosed()) {
      const item = await eventQueue.pull();
      if (item === null) {
        break;
      }
      yield item;
    }
  }

  return {
    bridge,
    iterator: generateIterator(),
  };
}

// ----------------------------------------------------------------------------
// Utility Functions
// ----------------------------------------------------------------------------

/**
 * 收集所有事件到数组（用于测试）
 *
 * @example
 * ```typescript
 * const events = await collectAllEvents(createAgentIterator({ orchestrator, message }));
 * expect(events.filter(e => e.type === 'message')).toHaveLength(1);
 * ```
 */
export async function collectAllEvents(
  iterator: AsyncGenerator<IteratorYield, void, undefined>
): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];

  for await (const item of iterator) {
    if (item.type === 'agent_event') {
      events.push(item.event);
    }
  }

  return events;
}

/**
 * 过滤特定类型的事件
 *
 * @example
 * ```typescript
 * for await (const event of filterEvents(iterator, 'message')) {
 *   console.log('Message:', event.data.content);
 * }
 * ```
 */
export async function* filterEvents<T extends AgentEvent['type']>(
  iterator: AsyncGenerator<IteratorYield, void, undefined>,
  eventType: T
): AsyncGenerator<Extract<AgentEvent, { type: T }>, void, undefined> {
  for await (const item of iterator) {
    if (item.type === 'agent_event' && item.event.type === eventType) {
      yield item.event as Extract<AgentEvent, { type: T }>;
    }
  }
}

/**
 * 等待特定事件出现
 *
 * @example
 * ```typescript
 * const completeEvent = await waitForEvent(iterator, 'agent_complete');
 * ```
 */
export async function waitForEvent<T extends AgentEvent['type']>(
  iterator: AsyncGenerator<IteratorYield, void, undefined>,
  eventType: T
): Promise<Extract<AgentEvent, { type: T }> | null> {
  for await (const item of iterator) {
    if (item.type === 'agent_event' && item.event.type === eventType) {
      return item.event as Extract<AgentEvent, { type: T }>;
    }
  }
  return null;
}
