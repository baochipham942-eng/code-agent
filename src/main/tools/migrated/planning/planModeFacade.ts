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
  ToolSchema,
} from '../../../protocol/tools';
import { executeEnterPlanMode } from './enterPlanMode';
import { executeExitPlanMode } from './exitPlanMode';

export const PLAN_MODE_ACTIONS = ['enter', 'exit'] as const;
type PlanModeAction = (typeof PLAN_MODE_ACTIONS)[number];

const schema: ToolSchema = {
  name: 'PlanMode',
  description: `Enter or exit plan mode for complex implementation tasks.

Actions:
- enter: Enter plan mode for exploration and design before implementing complex features.
    Params: reason (optional, why you are entering plan mode)
- exit: Exit plan mode and present the implementation plan for user approval.
    Params: plan (required, the implementation plan in Markdown format)

When to use plan mode:
- New feature implementation (not simple modifications)
- Multiple valid approaches need evaluation
- Architectural decisions required
- Multi-file changes (>3 files)
- Requirements are ambiguous and need exploration

When to skip:
- Single-line or small fixes (typos, simple bugs)
- Clear-cut single-function additions
- User gave detailed specific instructions`,
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: [...PLAN_MODE_ACTIONS],
        description: 'Enter or exit plan mode',
      },
      reason: {
        type: 'string',
        description: '[enter] Reason for entering plan mode (optional)',
      },
      plan: {
        type: 'string',
        description: '[exit] Implementation plan in Markdown format (required for exit)',
      },
    },
    required: ['action'],
  },
  category: 'planning',
  permissionLevel: 'write',
  readOnly: false,
  allowInPlanMode: true,
};

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
