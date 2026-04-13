// ============================================================================
// PlanMode facade (P0-6.3 Batch B1 — planning: native ToolModule rewrite)
//
// 旧版: src/main/tools/planning/PlanModeTool.ts (legacy Tool + wrapLegacyTool)
// 统一 enter/exit 入口，按 action 派发到 enterPlanMode/exitPlanMode 的核心函数
// （不绕 module.handler 一圈，直接调 execute* 导出函数）
// ============================================================================

import type {
  ToolHandler,
  ToolModule,
  ToolContext,
  CanUseToolFn,
  ToolProgressFn,
  ToolResult,
} from '../../../protocol/tools';
import { executeEnterPlanMode } from './enterPlanMode';
import { executeExitPlanMode } from './exitPlanMode';
import { planModeFacadeSchema as schema, PLAN_MODE_ACTIONS } from './planModeFacade.schema';

export { PLAN_MODE_ACTIONS };
type PlanModeAction = (typeof PLAN_MODE_ACTIONS)[number];

function isPlanModeAction(v: unknown): v is PlanModeAction {
  return typeof v === 'string' && (PLAN_MODE_ACTIONS as readonly string[]).includes(v);
}

class PlanModeFacadeHandler implements ToolHandler<Record<string, unknown>, string> {
  readonly schema = schema;

  async execute(
    args: Record<string, unknown>,
    ctx: ToolContext,
    canUseTool: CanUseToolFn,
    onProgress?: ToolProgressFn,
  ): Promise<ToolResult<string>> {
    const action = args.action;
    if (!isPlanModeAction(action)) {
      return {
        ok: false,
        error: `Unknown action: ${String(action)}. Valid actions: ${PLAN_MODE_ACTIONS.join(', ')}`,
        code: 'INVALID_ARGS',
      };
    }

    // facade 不做独立的 canUseTool / abort 检查 —— 派发到子 handler 后统一处理，
    // 避免双重 gate。但保留派发前的 progress 事件让上层能观察到 facade 转发。
    onProgress?.({ stage: 'starting', detail: `PlanMode action=${action}` });

    if (action === 'enter') {
      return executeEnterPlanMode(args, ctx, canUseTool, onProgress);
    }
    // action === 'exit'
    return executeExitPlanMode(args, ctx, canUseTool, onProgress);
  }
}

export const planModeFacadeModule: ToolModule<Record<string, unknown>, string> = {
  schema,
  createHandler() {
    return new PlanModeFacadeHandler();
  },
};
