// ============================================================================
// PlanFacade (P1 Wave 3 — planning: native ToolModule rewrite)
//
// 旧版: src/main/tools/planning/PlanTool.ts (legacy PlanTool)
// 改造点：
// - 4 参数签名 (args, ctx, canUseTool, onProgress)
// - 五链 + 错误码：PERMISSION_DENIED / ABORTED / INVALID_ARGS
// - 直接 dispatch 到 native sub-tool (executePlanRead/PlanUpdate/PlanRecoverRecentWork)
//   完全脱离 legacy Tool 委托
// - 行为保真：unknown action → INVALID_ARGS with valid list
//
// 注：unifed `Plan` facade，区别于 plan_mode facade（PlanMode）。
// ============================================================================

import type {
  ToolHandler,
  ToolModule,
  ToolContext,
  CanUseToolFn,
  ToolProgressFn,
  ToolResult,
} from '../../../protocol/tools';
import { planFacadeSchema as schema } from './planFacade.schema';
import { executePlanRead } from './planRead';
import { executePlanUpdate } from './planUpdate';
import { executePlanRecoverRecentWork } from './planRecoverRecentWork';

export async function executePlanFacade(
  args: Record<string, unknown>,
  ctx: ToolContext,
  canUseTool: CanUseToolFn,
  onProgress?: ToolProgressFn,
): Promise<ToolResult<string>> {
  const action = args.action;

  const permit = await canUseTool(schema.name, args);
  if (!permit.allow) {
    return { ok: false, error: `permission denied: ${permit.reason}`, code: 'PERMISSION_DENIED' };
  }
  if (ctx.abortSignal.aborted) {
    return { ok: false, error: 'aborted', code: 'ABORTED' };
  }

  onProgress?.({ stage: 'starting', detail: schema.name });

  switch (action) {
    case 'read':
      return executePlanRead(args, ctx, canUseTool, onProgress);
    case 'update':
      return executePlanUpdate(args, ctx, canUseTool, onProgress);
    case 'recover_recent_work':
      return executePlanRecoverRecentWork(args, ctx, canUseTool, onProgress);
    default:
      return {
        ok: false,
        error: `Unknown action: ${String(action)}. Valid actions: read, update, recover_recent_work`,
        code: 'INVALID_ARGS',
      };
  }
}

class PlanFacadeHandler implements ToolHandler<Record<string, unknown>, string> {
  readonly schema = schema;
  async execute(
    args: Record<string, unknown>,
    ctx: ToolContext,
    canUseTool: CanUseToolFn,
    onProgress?: ToolProgressFn,
  ): Promise<ToolResult<string>> {
    return executePlanFacade(args, ctx, canUseTool, onProgress);
  }
}

export const planFacadeModule: ToolModule<Record<string, unknown>, string> = {
  schema,
  createHandler() {
    return new PlanFacadeHandler();
  },
};
