// ============================================================================
// IPC Schemas — Runtime Validation Layer
// ============================================================================
//
// 设计目标：在不破坏 `shared/ipc/handlers.ts` 的编译时类型契约前提下，
// 给 IPC 边界加一层 zod 运行时校验，让 main 侧 handler 拿到的 payload 是
// **类型化 + 校验过**的，而不是 `any`。
//
// 用法：
//   1. 在 schemas/<domain>.ts 写 channel 的 payload + response schema
//   2. main 侧用 `defineHandler({ channel, payload, response }, async (event, payload) => ...)`
//   3. renderer 侧（dev 模式）用 `typedInvoke` 自动跑 response 校验
//
// 没注册 schema 的 channel 继续用旧的 `ipcMain.handle`，迁移可以渐进进行。
// ============================================================================

import { z } from 'zod';

// ----------------------------------------------------------------------------
// 通用信封（与 shared/ipc/domains.ts 的 IPCRequest/IPCResponse 接口对应）
// ----------------------------------------------------------------------------

export const IPCRequestSchema = <T extends z.ZodTypeAny>(payload: T) =>
  z.object({
    action: z.string(),
    payload: payload.optional(),
    requestId: z.string().optional(),
  });

export const IPCResponseSchema = <T extends z.ZodTypeAny>(data: T) =>
  z.discriminatedUnion('success', [
    z.object({ success: z.literal(true), data }),
    z.object({
      success: z.literal(false),
      error: z.object({
        code: z.string(),
        message: z.string(),
        details: z.unknown().optional(),
      }),
    }),
  ]);

// ----------------------------------------------------------------------------
// ChannelSchema — 单个 channel 的 payload + response 描述
// ----------------------------------------------------------------------------

/**
 * 描述一个 IPC channel 的运行时 schema。
 * - `payload` 必填，对入参做校验（main 侧）。
 * - `response` 可选，对返回值做校验（renderer 侧 dev 模式跑）。
 *
 * 用 `z.ZodType<unknown>` 而不是 `z.ZodTypeAny` —— 后者会把 output 类型
 * widen 成 any，触发 no-unsafe-return；前者保持 unknown，强制调用方在边界做断言。
 */
export interface ChannelSchema<
  P extends z.ZodType<unknown> = z.ZodType<unknown>,
  R extends z.ZodType<unknown> = z.ZodType<unknown>,
> {
  channel: string;
  payload: P;
  response?: R;
}

/**
 * 类型工具：从 ChannelSchema 推导出 payload 和 response 的 TypeScript 类型。
 */
export type PayloadOf<S extends ChannelSchema> = z.infer<S['payload']>;
export type ResponseOf<S extends ChannelSchema> =
  S['response'] extends z.ZodType<unknown> ? z.infer<S['response']> : void;

/**
 * 工厂函数：把 channel + zod schemas 组合成一个 ChannelSchema 对象。
 * 让调用点保持类型 inference。
 */
export function channelSchema<
  P extends z.ZodType<unknown>,
  R extends z.ZodType<unknown>,
>(args: { channel: string; payload: P; response?: R }): ChannelSchema<P, R> {
  return args;
}

// ----------------------------------------------------------------------------
// Schema registry — 按 domain 聚合
// ----------------------------------------------------------------------------
//
// 不强制把所有 channel 都注册到一个 mega-Map 里——那样会让 schemas 文件
// 变成上千行的怪物。每个 domain 自己导出一个 namespace，业务代码按需 import。
//
// 例：
//   import { EvaluationSchemas } from '@shared/ipc/schemas';
//   defineHandler(EvaluationSchemas.SAVE_ANNOTATIONS, async (_, payload) => ...)
//
export * as EvaluationSchemas from './evaluation';
