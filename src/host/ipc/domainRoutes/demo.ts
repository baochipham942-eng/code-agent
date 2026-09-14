// ============================================================================
// Demo 域路由表 —— RQ-183 刀 1 门骨架的最小自证表（非生产域，零装配）
// ============================================================================
//
// 用途：①让 domainRouteParity 门有第一张表可盯，自证「门会转」；②作为「最小表」
// 形态的活样板（action 用 z.enum、payload 保持 z.unknown——刀 2 起表化域允许的
// 起步形态，schema 细化是表立之后的增量，方案 2.1）。刀 2 session 表上线后加入
// 门清单逐步取代本表的位置。
//
// 本表不进 setupAllIpcHandlers、不映射任何 IPC_DOMAINS 真域——只在测试里装配。

import { z } from 'zod';
import { defineDomainRoutes } from './registry';
import { channelSchema } from '../../../shared/ipc/schemas/core';

const DemoRequestSchema = z.object({
  action: z.enum(['echo', 'ping']),
  payload: z.unknown().optional(),
  requestId: z.string().optional(),
});

/** demo 命令上下文：最小 ctx 形态——ctx 由装配方注入，handler 只依赖它拿服务 */
export interface DemoCommandContext {
  prefix: string;
}

export const demoRoutes = defineDomainRoutes(
  channelSchema({ channel: 'domain:demoRoutes', payload: DemoRequestSchema }),
  {
    // ctx 参数显式注解：Ctx 在 handler 签名的逆变位，靠字面量推断不出具体类型
    echo: async (ctx: DemoCommandContext, payload) => ({ message: `${ctx.prefix}:${String(payload ?? '')}` }),
    ping: async (ctx: DemoCommandContext) => ({ pong: ctx.prefix }),
  },
);
