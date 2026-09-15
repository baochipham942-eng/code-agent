// ============================================================================
// Domain Routes - 域路由表类型层（RQ-183 会话路由/命令面单源，刀 1 地基）
// ============================================================================
//
// 表分两层（方案 2.1）：action 集合真源在 shared/ipc/schemas（zod
// discriminatedUnion，或「action z.enum + payload z.unknown」的最小表）；handler 表
// 留 host 层（见 src/host/ipc/domainRoutes/registry.ts）——handler 需要 host 服务，
// 绝不进 shared。本文件只放类型，不带任何 host 依赖。
//
// handler 签名统一 (ctx, payload) => data（方案 2.2）：IPC event 参数由装配器吞掉，
// 抛错由装配器统一包错误响应，上下文差异（桌面 AppService / Web context）沉入 ctx。

import type { z } from 'zod';
import type { ChannelSchema } from './schemas/core';

/** 域路由请求的最小约束：带判别字段 action（discriminatedUnion 成员与 enum-action object 都满足） */
export interface DomainRouteRequest {
  action: string;
}

/** 单个 action 的 handler：(ctx, payload) => data。返回值进 IPCResponse.data */
export type DomainRouteHandler<Ctx, Payload> = (ctx: Ctx, payload: Payload) => unknown | Promise<unknown>;

/**
 * action → handler 表。映射类型天然穷尽：表缺 action、多 action 都是编译期红
 * （对象字面量直传或 satisfies 都触发 excess property 检查）。
 */
export type DomainRouteHandlers<Req extends DomainRouteRequest, Ctx = unknown> = {
  [A in Req['action'] & string]: DomainRouteHandler<Ctx, ActionPayload<Req, A>>;
};

/** 从请求联合里按 action 提取对应 payload 类型（payload 可选或缺失的 action 给 undefined）；
 *  单对象 enum 表（非联合）Extract 必得 never，退回 Req 自身的 payload 类型 */
type ActionPayload<Req extends DomainRouteRequest, A extends string> =
  Extract<Req, { action: A }> extends { payload?: infer P } ? P : undefined;

/**
 * 域路由表：装配器与 parity 门共用的单一形态。`Object.keys(actions)` 即 action
 * 集合——门从正则提取升级为结构枚举的根基。
 */
export interface DomainRouteTable<Req extends DomainRouteRequest, Ctx = unknown> {
  /** 域通道名（IPC_DOMAINS.X） */
  channel: string;
  /** 请求 schema（channelSchema 形态，payload 即完整 request union） */
  requestSchema: ChannelSchema<z.ZodType<Req>>;
  /** action → handler 映射，keys 即 action 集合 */
  actions: DomainRouteHandlers<Req, Ctx>;
  /** 领域错误 → IPC error code 判定；未提供或未命中时装配器兜底 INTERNAL_ERROR */
  resolveErrorCode?: (error: unknown) => string | undefined;
  /**
   * 未知 action 兜底文案（默认 `Unknown action: <action>`）。个别域的既有错误契约
   * 前缀不同（如 session 域 web 形态的 `Unknown session action: <action>`），表化
   * 迁移期用它保持响应逐字不变。
   */
  unknownActionMessage?: (action: unknown) => string;
  /** 未知 action 兜底 code（默认 INVALID_ACTION） */
  unknownActionCode?: string;
  /** handler 抛错 → 完整 error（提供时优先于 resolveErrorCode / INTERNAL_ERROR 兜底） */
  mapError?: (error: unknown, action: unknown) => { code: string; message: string };
  /** handler 返回完整 IPCResponse，装配器原样透传（不包 { success: true, data }） */
  rawResponse?: boolean;
  /**
   * 该表面暂缓（web:false）的 action 清单——keys 仍在 actions 里（桩 handler 抛
   * INVALID_ACTION），此字段是给 parity 门做「只减不增」棘轮的对账标记。
   */
  disabledActions?: readonly string[];
}
