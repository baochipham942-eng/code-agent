// ============================================================================
// Platform: IPC Registry - 替代 Electron ipcMain 运行时对象
// ============================================================================
//
// Map-based handler 注册表。
// Web 模式下 webServer 从 handlers Map 读取来路由 HTTP 请求。
//
// 提供两条注册路径：
//  1. `ipcMain.handle(channel, handler)` — 旧路径，payload 是 any，逐步淘汰。
//  2. `defineHandler(schema, handler)` — 新路径，payload 通过 zod 校验后类型化。
//
// ============================================================================

import type { ChannelSchema, PayloadOf, ResponseOf } from '../../shared/ipc/schemas';
import { createErrorResponse } from '../../shared/ipc/protocol';
import { createLogger } from '../services/infra/logger';
import type { HandlerFn, IpcMain, IpcMainInvokeEvent } from './ipcTypes';

const logger = createLogger('IpcRegistry');

/** 所有通过 ipcMain.handle() 注册的 handler */
export const handlers = new Map<string, HandlerFn>();

/** 所有通过 ipcMain.on() 注册的 listener */
export const eventListeners = new Map<string, HandlerFn>();

/**
 * ipcMain 运行时 — 兼容 Electron ipcMain API
 */
export const ipcMain: IpcMain & {
  removeHandler(channel: string): void;
  removeAllListeners(channel?: string): void;
} = {
  handle(channel: string, handler: HandlerFn): void {
    handlers.set(channel, handler);
  },
  on(channel: string, handler: HandlerFn): void {
    eventListeners.set(channel, handler);
  },
  once(_channel: string, _handler: HandlerFn): void {
    // no-op in web mode
  },
  removeHandler(channel: string): void {
    handlers.delete(channel);
  },
  removeAllListeners(channel?: string): void {
    if (channel) {
      eventListeners.delete(channel);
    } else {
      eventListeners.clear();
    }
  },
};

// ----------------------------------------------------------------------------
// defineHandler — 类型化 + 运行时校验的 IPC handler 注册器
// ----------------------------------------------------------------------------

/**
 * 注册带 zod 校验的 IPC handler。
 *
 * - 入站 payload 用 schema.payload.safeParse 校验，失败返回 INVALID_PAYLOAD 错误响应。
 * - handler 抛错时返回 INTERNAL_ERROR 错误响应（不让异常逃逸到 IPC 层）。
 * - 不强制对 response 跑校验（避免 hot path 双倍开销）；renderer 侧 dev 模式会跑。
 *
 * 用法:
 * ```ts
 * import { EvaluationSchemas } from '@shared/ipc/schemas';
 * defineHandler(EvaluationSchemas.SAVE_ANNOTATIONS, async (_event, payload) => {
 *   //                                                       ^? Annotation
 *   return { success: true };
 * });
 * ```
 */
export function defineHandler<S extends ChannelSchema>(
  schema: S,
  handler: (event: IpcMainInvokeEvent, payload: PayloadOf<S>) => Promise<ResponseOf<S>>,
  target: Pick<IpcMain, 'handle'> = ipcMain,
): void {
  target.handle(schema.channel, async (event: IpcMainInvokeEvent, rawPayload: unknown) => {
    const parsed = schema.payload.safeParse(rawPayload);
    if (!parsed.success) {
      logger.warn(`[IPC] payload validation failed for ${schema.channel}`, {
        issues: parsed.error.issues,
      });
      return createErrorResponse('INVALID_PAYLOAD', parsed.error.message, parsed.error.issues);
    }
    try {
      return await handler(event, parsed.data as PayloadOf<S>);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error(`[IPC] handler ${schema.channel} threw`, err);
      return createErrorResponse('INTERNAL_ERROR', message);
    }
  });
}
