// ============================================================================
// Protocol Events — 统一导出
// - categories: HOOK_EVENTS 字典、BATCHABLE/IMMEDIATE 分类、AgentEvent 类型白名单
// - busTypes:   EventDomain/BusEvent/EventHandler/EventPattern runtime 类型
// - bus:        EventBus runtime + getEventBus/shutdownEventBus
// - bridge:     EventBridge（EventBus → IPC 桥接）
// - internalStore: 持久化事件存储
// - replay:     基于 store 的事件回放
// - controlStream: 轻量级同步派发流
// ============================================================================

export * from './categories';
export * from './busTypes';
export { EventBus, getEventBus, shutdownEventBus } from './bus';
export { EventBridge, initEventBridge, getEventBridge } from './bridge';
export {
  InternalEventStore,
  getInternalEventStore,
  resetInternalEventStore,
  type StoredEvent,
} from './internalStore';
export { EventReplay } from './replay';
export { ControlStream } from './controlStream';
