// ============================================================================
// Services Eventing — 主进程事件 runtime 统一导出
//
// 类型契约（EventDomain / BusEvent / HookEvent / categories 谓词等）仍在
// protocol/events/，业务侧需要 runtime 时从此处 import，需要类型时从
// protocol/events 直接 import。
//
// - bus:           EventBus + getEventBus / shutdownEventBus
// - bridge:        EventBridge（EventBus → IPC 桥接）
// - internalStore: 持久化事件存储 + getInternalEventStore / resetInternalEventStore
// - replay:        基于 store 的事件回放
// - controlStream: 轻量级同步派发流
// ============================================================================

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
