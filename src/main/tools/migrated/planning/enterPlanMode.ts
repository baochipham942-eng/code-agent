// ============================================================================
// EnterPlanMode (P0-6.3 Batch B1 — planning: native ToolModule rewrite)
//
// 旧版: src/main/tools/planning/enterPlanMode.ts (legacy Tool + wrapLegacyTool)
// 改造点：
// - 4 参数签名 (args, ctx, canUseTool, onProgress)
// - inline canUseTool 闸门 + onProgress 事件
// - 走 ctx.logger
// - 使用 ctx.planMode.enter(reason) 替代 legacy ctx.setPlanMode(true)
// - 发射 AgentEvent `plan_mode_entered`（走 ctx.emit，替代 legacy emitEvent）
// - 行为保真：markdown 输出文案完全保留（前端依赖）
// ============================================================================

import type {
  ToolHandler,
  ToolModule,
  ToolContext,
  CanUseToolFn,
  ToolProgressFn,
  ToolResult,
  PlanModeController,
} from '../../../protocol/tools';
import { enterPlanModeSchema as schema } from './enterPlanMode.schema';

export const DEFAULT_ENTER_REASON = '复杂任务需要前期规划';

/** 构造进入规划模式的提示文本（和 legacy 完全一致） */
export function buildEnterPlanModeOutput(reason: string): string {
  return `## 📋 已进入规划模式

**原因：** ${reason}

**当前阶段：** 探索与设计

### 你现在应该：
1. 使用 \`glob\`、\`grep\`、\`read_file\` 探索代码库
2. 理解现有架构和模式
3. 设计实现方案
4. 完成后使用 \`exit_plan_mode\` 提交计划

### 规划模式期间：
- ✅ 可以：读取文件、搜索代码、分析架构
- ❌ 避免：执行写入操作、提交代码

准备好计划后，调用 \`exit_plan_mode\` 并提供详细的实现计划。`;
}

/**
 * 执行进入规划模式的核心逻辑（facade 直接复用，不绕 module.handler）。
 */
export async function executeEnterPlanMode(
  args: Record<string, unknown>,
  ctx: ToolContext,
  canUseTool: CanUseToolFn,
  onProgress?: ToolProgressFn,
): Promise<ToolResult<string>> {
  const rawReason = args.reason;
  if (rawReason !== undefined && typeof rawReason !== 'string') {
    return { ok: false, error: 'reason must be a string', code: 'INVALID_ARGS' };
  }

  const permit = await canUseTool(schema.name, args);
  if (!permit.allow) {
    return { ok: false, error: `permission denied: ${permit.reason}`, code: 'PERMISSION_DENIED' };
  }
  if (ctx.abortSignal.aborted) {
    return { ok: false, error: 'aborted', code: 'ABORTED' };
  }

  onProgress?.({ stage: 'starting', detail: 'entering plan mode' });

  const reason = (typeof rawReason === 'string' && rawReason.length > 0)
    ? rawReason
    : DEFAULT_ENTER_REASON;

  const controller: PlanModeController | undefined = ctx.planMode;
  if (!controller) {
    return {
      ok: false,
      error: 'plan mode controller not initialized',
      code: 'NOT_INITIALIZED',
    };
  }

  controller.enter(reason);
  ctx.emit({ type: 'plan_mode_entered', data: { reason } });
  ctx.logger.debug('enter_plan_mode', { reason });

  onProgress?.({ stage: 'completing', percent: 100 });
  return {
    ok: true,
    output: buildEnterPlanModeOutput(reason),
    meta: { reason },
  };
}

class EnterPlanModeHandler implements ToolHandler<Record<string, unknown>, string> {
  readonly schema = schema;
  execute(
    args: Record<string, unknown>,
    ctx: ToolContext,
    canUseTool: CanUseToolFn,
    onProgress?: ToolProgressFn,
  ): Promise<ToolResult<string>> {
    return executeEnterPlanMode(args, ctx, canUseTool, onProgress);
  }
}

export const enterPlanModeModule: ToolModule<Record<string, unknown>, string> = {
  schema,
  createHandler() {
    return new EnterPlanModeHandler();
  },
};
