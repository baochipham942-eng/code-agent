// ============================================================================
// IPC Schemas — Runtime Validation Layer
// ============================================================================
//
// 设计目标：在不破坏 `shared/ipc/handlers.ts` 的编译时类型契约前提下，
// 给 IPC 边界加一层 zod 运行时校验，让 main 侧 handler 拿到的 payload 是
// 类型化 + 校验过的，而不是 `any`。
//
// 没注册 schema 的 channel 继续用旧的 `ipcMain.handle`，迁移可以渐进进行。
// 每个 domain 自己导出一个 namespace，业务代码按需 import。
// ============================================================================

export {
  IPCRequestSchema,
  IPCResponseSchema,
  channelSchema,
} from './core';
export type {
  ChannelSchema,
  PayloadOf,
  ResponseOf,
} from './core';

export { BackgroundTaskSchemas } from './backgroundTask';
export type { BackgroundTaskRequest } from './backgroundTask';
export { QueuedInputSchemas, QueuedInputSchema } from './queuedInput';
export type { QueuedInputRequest } from './queuedInput';
export { AdminSchemas } from './admin';
export type { AdminRequest } from './admin';
