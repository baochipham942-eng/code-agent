// ============================================================================
// EventBus - 全局事件总线
// ============================================================================
// 轻量级事件总线，基于 EventEmitter
// 支持 domain:type、domain、* 三级匹配
// ============================================================================

import { EventEmitter } from 'events';
import type { EventDomain, BusEvent, EventHandler, EventPattern } from './types';
import { createLogger } from '../services/infra/logger';

const logger = createLogger('EventBus');

class EventBus {
  private emitter = new EventEmitter();
  private _isShutdown = false;

  constructor() {
    // 提高监听器上限，避免 MaxListenersExceededWarning
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

    // 发射到三个通道
    this.safeEmit(`${domain}:${type}`, event);
    this.safeEmit(domain, event);
    this.safeEmit('*', event);
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

  /**
   * 订阅一次性事件
   */
  once<T = unknown>(pattern: EventPattern, handler: EventHandler<T>): () => void {
    this.emitter.once(pattern, handler);
    return () => {
      this.emitter.removeListener(pattern, handler);
    };
  }

  /**
   * 关闭事件总线
   */
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

// ============================================================================
// 全局单例
// ============================================================================

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
