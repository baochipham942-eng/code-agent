// ============================================================================
// EventBridge - EventBus → IPC 桥接
// ============================================================================
// 订阅 EventBus 的 '*' 通道，过滤后转发到渲染进程
// 向后兼容现有 IPC channel 名
// ============================================================================

import type { BrowserWindow } from 'electron';
import type { BusEvent, EventDomain } from './types';
import { getEventBus } from './eventBus';
import { createLogger } from '../services/infra/logger';

const logger = createLogger('EventBridge');

/** 不转发到渲染进程的 domain */
const INTERNAL_DOMAINS: EventDomain[] = ['system'];

/** domain → IPC channel 映射（向后兼容） */
const DOMAIN_TO_CHANNEL: Partial<Record<EventDomain, string>> = {
  agent: 'agent:event',
  session: 'session:event',
  tool: 'tool:event',
  planning: 'planning:event',
  memory: 'memory:event',
  lsp: 'lsp:event',
  ui: 'ui:event',
};

export class EventBridge {
  private getWindow: () => BrowserWindow | null;
  private unsubscribe: (() => void) | null = null;

  constructor(getWindow: () => BrowserWindow | null) {
    this.getWindow = getWindow;
  }

  /**
   * 开始桥接
   */
  start(): EventBridge {
    if (this.unsubscribe) return this;

    const bus = getEventBus();
    this.unsubscribe = bus.subscribe('*', (event: BusEvent) => {
      this.forward(event);
    });

    logger.info('EventBridge started');
    return this;
  }

  /**
   * 停止桥接
   */
  stop(): void {
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
      logger.info('EventBridge stopped');
    }
  }

  private forward(event: BusEvent): void {
    // 过滤 bridgeToRenderer: false
    if (event.bridgeToRenderer === false) return;

    // 过滤 internal domain
    if (INTERNAL_DOMAINS.includes(event.domain)) return;

    const window = this.getWindow();
    if (!window || window.isDestroyed()) return;

    const channel = DOMAIN_TO_CHANNEL[event.domain] || `${event.domain}:event`;

    try {
      window.webContents.send(channel, {
        type: event.type,
        data: event.data,
        timestamp: event.timestamp,
        sessionId: event.sessionId,
      });
    } catch (err) {
      logger.debug(`EventBridge forward failed for ${channel}:`, err);
    }
  }
}

// ============================================================================
// 全局单例
// ============================================================================

let globalBridge: EventBridge | null = null;

export function initEventBridge(getWindow: () => BrowserWindow | null): EventBridge {
  if (globalBridge) {
    globalBridge.stop();
  }
  globalBridge = new EventBridge(getWindow);
  return globalBridge;
}

export function getEventBridge(): EventBridge | null {
  return globalBridge;
}
