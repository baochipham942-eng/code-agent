// ============================================================================
// Domain Routes Registry - 域路由表原语 + 装配器（RQ-183 刀 1 地基，零行为变化）
// ============================================================================
//
// 沿第 3 代 schema 体系（ipcRegistry.defineHandler）扩展的「一域一表」原语：
//   - defineDomainRoutes(schema, handlers)：handler 表被 DomainRouteHandlers<Req>
//     钉死，缺/多 action 编译期即红；返回的表可枚举（Object.keys(actions)），
//     parity 门从此不靠正则提取。
//   - installDomainRoutes(target, table, ctx)：把表装配进 handlers Map
//     （ipcMain.handle）。未知 action 的 INVALID_ACTION 兜底对齐
//     session.ipc.ts:304-311 现状语义，错误 code 传递对齐 :315-329
//     （领域 code 优先、INTERNAL_ERROR 兜底、message 提取同款）。
//
// 与 defineHandler 的分工：defineHandler 面向「一 action 一 channelSchema」的新通道
// （payload safeParse 失败 → INVALID_PAYLOAD）；本装配器面向既有域 switch 的表化迁移，
// payload 透传不校验——迁移期行为严格不变，payload zod 细化是表立之后的增量（方案 2.5）。
//
// ⚠️ 刀 1 状态：尚无生产域装配本原语（消费方只有门骨架与测试），setupAllIpcHandlers
// 装配顺序不动。新命令一律进域表，别再开独立 REST 面（存量流式/上传/历史兼容面除外，
// 见方案 1.5 登记清单）。

import { ZodDiscriminatedUnion, ZodEnum, ZodLiteral, ZodObject, ZodUnion, type z } from 'zod';
import type {
  DomainRouteHandler,
  DomainRouteHandlers,
  DomainRouteRequest,
  DomainRouteTable,
} from '../../../shared/ipc/domainRoutes';
import type { ChannelSchema } from '../../../shared/ipc/schemas/core';
import type { IpcMain } from '../../platform/ipcTypes';

/** 领域错误 → IPC error code 的判定（如 session 域的 SessionForkError instanceof 家族） */
export interface DomainRouteOptions {
  resolveErrorCode?: (error: unknown) => string | undefined;
}

/**
 * 定义域路由表。handlers 的键集合被 schema 的 action union 钉死：
 * 表缺 action、多 action 都是 typecheck 红；install 时还有运行时对称校验兜底。
 */
export function defineDomainRoutes<Req extends DomainRouteRequest, Ctx>(
  schema: ChannelSchema<z.ZodType<Req>>,
  handlers: DomainRouteHandlers<Req, Ctx>,
  options?: DomainRouteOptions,
): DomainRouteTable<Req, Ctx> {
  return {
    channel: schema.channel,
    requestSchema: schema,
    actions: handlers,
    ...(options?.resolveErrorCode ? { resolveErrorCode: options.resolveErrorCode } : {}),
  };
}

/**
 * 把域路由表装配进 handlers Map。装配前做双向防漂移校验（表 ⊄ schema / schema ⊄ 表
 * 都拒绝装配）——编译期穷尽之外的运行时兜底，挡动态构造/as-any 绕过类型的表错位。
 */
export function installDomainRoutes<Req extends DomainRouteRequest, Ctx>(
  target: Pick<IpcMain, 'handle'>,
  table: DomainRouteTable<Req, Ctx>,
  ctx: Ctx,
): void {
  const schemaActions = extractDomainActions(table.requestSchema.payload);
  if (schemaActions.size === 0) {
    throw new Error(
      `[domainRoutes] ${table.channel}: request schema 提取到 0 个 action——schema 形态不被识别或传错了 schema，拒绝装配`,
    );
  }

  const undeclared = Object.keys(table.actions).filter((action) => !schemaActions.has(action));
  if (undeclared.length > 0) {
    throw new Error(
      `[domainRoutes] ${table.channel}: 表里有 schema 未声明的 action [${undeclared.join(', ')}]——表与 schema 漂移，拒绝装配`,
    );
  }

  const missing = [...schemaActions].filter((action) => !Object.hasOwn(table.actions, action));
  if (missing.length > 0) {
    throw new Error(
      `[domainRoutes] ${table.channel}: schema 声明了但表缺 action [${missing.join(', ')}]——表与 schema 漂移，拒绝装配`,
    );
  }

  target.handle(table.channel, async (_event: unknown, raw: unknown) => {
    const request = raw as { action?: unknown; payload?: unknown } | null | undefined;
    const action = request && typeof request === 'object' ? request.action : undefined;
    // hasOwn 而非索引直取/in：挡 Object.prototype 继承键（toString/constructor 等）被当成合法 action 分发
    const handler = typeof action === 'string' && Object.hasOwn(table.actions, action)
      ? (table.actions as Record<string, DomainRouteHandler<Ctx, unknown>>)[action]
      : undefined;

    if (!handler) {
      // 未知 action 兜底，对齐 session.ipc.ts:304-311 现状语义
      return {
        success: false,
        error: {
          code: 'INVALID_ACTION',
          message: `Unknown action: ${String(action)}`,
        },
      };
    }

    try {
      return { success: true, data: await handler(ctx, request?.payload) };
    } catch (error) {
      // 错误 code 传递，对齐 session.ipc.ts:315-329：领域 code 优先、INTERNAL_ERROR 兜底
      return {
        success: false,
        error: {
          code: table.resolveErrorCode?.(error) ?? 'INTERNAL_ERROR',
          message: error instanceof Error ? error.message : String(error),
        },
      };
    }
  });
}

/**
 * 从 request schema 提取声明的 action 集合——parity 门与装配器共用的结构枚举，
 * 取代 sessionActionSurfacesParity 的源码正则提取。支持两种形态：
 * z.discriminatedUnion('action', [...]) 与 z.object({ action: z.enum/literal/union })。
 * 认不出的形态返回空集合，调用方自举纪律兜底（门红 / install 抛错）。
 */
export function extractDomainActions(requestSchema: unknown): ReadonlySet<string> {
  const actions = new Set<string>();
  collectActionLiterals(requestSchema, actions);
  return actions;
}

function collectActionLiterals(node: unknown, out: Set<string>): void {
  if (node instanceof ZodDiscriminatedUnion) {
    for (const option of node.options) {
      collectActionLiterals((option as ZodObject).shape.action, out);
    }
    return;
  }
  if (node instanceof ZodEnum) {
    for (const value of node.options) {
      if (typeof value === 'string') out.add(value);
    }
    return;
  }
  if (node instanceof ZodLiteral) {
    if (typeof node.value === 'string') out.add(node.value);
    return;
  }
  if (node instanceof ZodUnion) {
    for (const option of node.options) {
      collectActionLiterals(option, out);
    }
    return;
  }
  if (node instanceof ZodObject) {
    collectActionLiterals(node.shape.action, out);
  }
}
