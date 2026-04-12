// ============================================================================
// ExitPlanMode (P0-6.3 Batch B1 — planning: native ToolModule rewrite)
//
// 旧版: src/main/tools/planning/exitPlanMode.ts (legacy Tool + wrapLegacyTool)
// 改造点：
// - 4 参数签名 (args, ctx, canUseTool, onProgress)
// - inline canUseTool 闸门 + onProgress 事件
// - 使用 ctx.planMode.exit(...) 替代 legacy ctx.setPlanMode(false)
// - 发射 AgentEvent `plan_mode_exited`（走 ctx.emit）
// - 行为保真：
//   * plan 参数必填且非空
//   * markdown 文本完全对齐 legacy
//   * meta.requiresUserConfirmation / confirmationType / plan 保留
//     （toolExecutionEngine 依赖此字段做 autoApprovePlan）
// ============================================================================

import type {
  ToolHandler,
  ToolModule,
  ToolContext,
  CanUseToolFn,
  ToolProgressFn,
  ToolResult,
  ToolSchema,
  PlanModeController,
} from '../../../protocol/tools';

export const PLAN_CONFIRMATION_TYPE = 'plan_approval';

const schema: ToolSchema = {
  name: 'exit_plan_mode',
  description: `退出规划模式，向用户呈现实现计划以供审批。

**何时使用：**
- 已完成代码探索
- 已设计好实现方案
- 准备好供用户审批

**何时不用：**
- 纯研究/探索任务
- 简单的信息查询
- 尚未完成规划

**计划应包含：**
- 修改的文件清单
- 每个文件的修改内容概述
- 实现步骤（按顺序）
- 潜在风险或注意事项`,
  inputSchema: {
    type: 'object',
    properties: {
      plan: {
        type: 'string',
        description: '实现计划（支持 Markdown 格式），应包含文件清单、修改内容和实现步骤',
      },
    },
    required: ['plan'],
  },
  category: 'planning',
  permissionLevel: 'write',
  readOnly: false,
  allowInPlanMode: true,
};

/** 构造退出规划模式的提示文本（和 legacy 完全一致） */
export function buildExitPlanModeOutput(plan: string): string {
  return `## 📋 实现计划

${plan}

---

### ⏳ 等待确认

请审阅上述计划，然后告诉我：
- **确认执行**：我将按计划开始实现
- **修改计划**：告诉我需要调整的部分
- **取消**：如果不需要继续`;
}

/**
 * 执行退出规划模式的核心逻辑（facade 直接复用）。
 */
export async function executeExitPlanMode(
  args: Record<string, unknown>,
  ctx: ToolContext,
  canUseTool: CanUseToolFn,
  onProgress?: ToolProgressFn,
): Promise<ToolResult<string>> {
  const rawPlan = args.plan;
  if (typeof rawPlan !== 'string') {
    return {
      ok: false,
      error: '请提供实现计划。计划应包含修改的文件清单、修改内容和实现步骤。',
      code: 'INVALID_ARGS',
    };
  }
  const plan = rawPlan;
  if (plan.trim().length === 0) {
    return {
      ok: false,
      error: '请提供实现计划。计划应包含修改的文件清单、修改内容和实现步骤。',
      code: 'INVALID_ARGS',
    };
  }

  const permit = await canUseTool(schema.name, args);
  if (!permit.allow) {
    return { ok: false, error: `permission denied: ${permit.reason}`, code: 'PERMISSION_DENIED' };
  }
  if (ctx.abortSignal.aborted) {
    return { ok: false, error: 'aborted', code: 'ABORTED' };
  }

  onProgress?.({ stage: 'starting', detail: 'exiting plan mode' });

  const controller: PlanModeController | undefined = ctx.planMode;
  if (!controller) {
    return {
      ok: false,
      error: 'plan mode controller not initialized',
      code: 'NOT_INITIALIZED',
    };
  }

  controller.exit();
  ctx.emit({ type: 'plan_mode_exited', data: { plan } });
  ctx.logger.debug('exit_plan_mode', { planLength: plan.length });

  onProgress?.({ stage: 'completing', percent: 100 });
  return {
    ok: true,
    output: buildExitPlanModeOutput(plan),
    meta: {
      requiresUserConfirmation: true,
      confirmationType: PLAN_CONFIRMATION_TYPE,
      plan,
    },
  };
}

class ExitPlanModeHandler implements ToolHandler<Record<string, unknown>, string> {
  readonly schema = schema;
  execute(
    args: Record<string, unknown>,
    ctx: ToolContext,
    canUseTool: CanUseToolFn,
    onProgress?: ToolProgressFn,
  ): Promise<ToolResult<string>> {
    return executeExitPlanMode(args, ctx, canUseTool, onProgress);
  }
}

export const exitPlanModeModule: ToolModule<Record<string, unknown>, string> = {
  schema,
  createHandler() {
    return new ExitPlanModeHandler();
  },
};
