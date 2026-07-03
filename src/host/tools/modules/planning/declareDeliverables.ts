// ============================================================================
// declare_deliverables — 最终产物路径声明工具
//
// 真正的处理在 messageProcessor 拦截：那里能拿到 RuntimeContext，
// 可以写入 ctx.declaredDeliverables，并把确认消息注回下一轮推理。
// 本 executor 只是兜底——当拦截未生效时返回无害确认，不产生副作用。
// ============================================================================

import type {
  ToolHandler,
  ToolModule,
  ToolContext,
  CanUseToolFn,
  ToolProgressFn,
  ToolResult,
} from '../../../protocol/tools';
import { declareDeliverablesSchema as schema } from './declareDeliverables.schema';

export async function executeDeclareDeliverables(
  _args: Record<string, unknown>,
  _ctx: ToolContext,
  _canUseTool: CanUseToolFn,
  _onProgress?: ToolProgressFn,
): Promise<ToolResult<string>> {
  return {
    ok: true,
    output: 'declare_deliverables 的声明状态由运行时拦截器记录；当前 executor 兜底无副作用。',
  };
}

class DeclareDeliverablesHandler implements ToolHandler<Record<string, unknown>, string> {
  readonly schema = schema;
  async execute(
    args: Record<string, unknown>,
    ctx: ToolContext,
    canUseTool: CanUseToolFn,
    onProgress?: ToolProgressFn,
  ): Promise<ToolResult<string>> {
    return executeDeclareDeliverables(args, ctx, canUseTool, onProgress);
  }
}

export const declareDeliverablesModule: ToolModule<Record<string, unknown>, string> = {
  schema,
  createHandler() {
    return new DeclareDeliverablesHandler();
  },
};
