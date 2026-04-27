// ============================================================================
// Protocol Events — 事件类型契约统一导出
//
// 只放类型和常量。Runtime（EventBus / EventBridge / InternalEventStore /
// EventReplay / ControlStream）已搬到 src/main/services/eventing/，需要 runtime
// 的业务代码从那里 import。
//
// - categories: BATCHABLE/IMMEDIATE 分类、AgentEvent 类型白名单、分类谓词
// - hookTypes:  HookEvent union + 19 种 Context + HookExecutionResult + HOOK_ENV_VARS
// - busTypes:   EventDomain/BusEvent/EventHandler/EventPattern runtime 类型
// ============================================================================

export * from './categories';
export * from './hookTypes';
export * from './busTypes';
