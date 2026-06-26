// ============================================================================
// planningStateEmitter — main process 内部事件总线
// ============================================================================
//
// 单独成文件的原因：planningStatePublisher.ts 依赖 getMainWindow / electron app，
// 加载时会拖入大量 main-process 模块（mcpDefaultServers / configService / 等）。
// 测试侧若 mock 'platform' 但漏掉 'app' 导出，import publisher 就会炸。
//
// 把 emitter 拆出来后，consumer（如 MasterTaskManager）只需 import 这个轻量文件，
// 既避免 import cycle，也让单测 mock 面积最小化。
//
// 事件契约：emitter.emit('plan_updated', state: PlanningState)
// ============================================================================

import { EventEmitter } from 'events';

/**
 * 内部事件总线 — main process 内部订阅者用（如 MasterTaskManager.subscribeToPlanning）。
 * renderer 走 IPC（PLANNING_EVENT_CHANNEL），main 进程内部不能监听自己 send 的 IPC，
 * 所以用这个 EventEmitter 做内进程总线。
 *
 * 事件：'plan_updated'，payload 是完整 PlanningState 快照（plan / findings / errors）。
 */
export const planningStateEmitter = new EventEmitter();
