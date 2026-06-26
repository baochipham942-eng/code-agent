// ============================================================================
// EventBus - 全局事件总线
// 轻量级事件总线，基于 EventEmitter
// 支持 domain:type、domain、* 三级匹配
// 原 src/main/events/eventBus.ts，P0-5 阶段 A 迁入 protocol 层；
// 2026-04-27 从 protocol/events/ 搬到 services/eventing/，因为 EventBus 是
// runtime singleton，违反 protocol/ "只放类型和常量" 约束。busTypes 留在
// protocol/events/ 作为类型契约。
// ============================================================================

import { EventEmitter } from 'events';
import type { EventDomain, BusEvent, EventHandler, EventPattern } from '../../protocol/events/busTypes';
import { createLogger } from '../infra/logger';
import { getInternalEventStore } from './internalStore';

const logger = createLogger('EventBus');

class EventBus {
  private emitter = new EventEmitter();
  private _isShutdown = false;

  constructor() {
    this.emitter.setMaxListeners(100);
  }

  /**
   * 发布事件
   * 事件会被发射到三个通道：`domain:type`、`domain`、`*`
   */
  publish<T>(
    domain: EventDomain,
    type: string,
    data: T,
    options?: { sessionId?: string; bridgeToRenderer?: boolean }
  ): void {
    if (this._isShutdown) return;

    const event: BusEvent<T> = {
      domain,
      type,
      data,
      timestamp: Date.now(),
      sessionId: options?.sessionId,
      bridgeToRenderer: options?.bridgeToRenderer ?? true,
    };

    this.safeEmit(`${domain}:${type}`, event);
    this.safeEmit(domain, event);
    this.safeEmit('*', event);

    const PERSISTENT_DOMAINS = ['tool', 'agent', 'session'];
    if (PERSISTENT_DOMAINS.includes(domain)) {
      try {
        getInternalEventStore().writeEvent({
          agentId: options?.sessionId || 'main',
          domain,
          type,
          data,
          timestamp: event.timestamp,
        });
      } catch { /* non-blocking */ }
    }
  }

  /**
   * 订阅事件
   * @param pattern - 匹配模式：'domain:type' | 'domain' | '*'
   * @returns unsubscribe 函数
   */
  subscribe<T = unknown>(pattern: EventPattern, handler: EventHandler<T>): () => void {
    this.emitter.on(pattern, handler);
    return () => {
      this.emitter.removeListener(pattern, handler);
    };
  }

  once<T = unknown>(pattern: EventPattern, handler: EventHandler<T>): () => void {
    this.emitter.once(pattern, handler);
    return () => {
      this.emitter.removeListener(pattern, handler);
    };
  }

  shutdown(): void {
    this._isShutdown = true;
    this.emitter.removeAllListeners();
  }

  get isShutdown(): boolean {
    return this._isShutdown;
  }

  private safeEmit(channel: string, event: BusEvent): void {
    try {
      this.emitter.emit(channel, event);
    } catch (err) {
      logger.error(`EventBus handler error on channel '${channel}':`, err);
    }
  }
}

let globalBus: EventBus | null = null;

export function getEventBus(): EventBus {
  if (!globalBus) {
    globalBus = new EventBus();
  }
  return globalBus;
}

export function shutdownEventBus(): void {
  if (globalBus) {
    globalBus.shutdown();
    globalBus = null;
  }
}

export { EventBus };
