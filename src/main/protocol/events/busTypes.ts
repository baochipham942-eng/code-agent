// ============================================================================
// EventBus Types — runtime 事件发布订阅的基础类型
// 原 src/main/events/types.ts，P0-5 阶段 A 迁入 protocol 层
// ============================================================================

export type EventDomain =
  | 'agent'
  | 'session'
  | 'tool'
  | 'planning'
  | 'memory'
  | 'lsp'
  | 'system'
  | 'ui';

export interface BusEvent<T = unknown> {
  domain: EventDomain;
  type: string;
  data: T;
  timestamp: number;
  sessionId?: string;
  /** 是否桥接到渲染进程，默认 true */
  bridgeToRenderer?: boolean;
}

export type EventHandler<T = unknown> = (event: BusEvent<T>) => void | Promise<void>;

export type EventPattern = string; // 'domain:type' | 'domain' | '*'
