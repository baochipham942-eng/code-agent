// ============================================================================
// PlanRead (P1 Wave 3 — planning: native ToolModule rewrite)
//
// 旧版: src/host/tools/planning/planRead.ts (legacy Tool planReadTool)
// 改造点：
// - 4 参数签名 (args, ctx, canUseTool, onProgress)
// - 五链：参数校验 / canUseTool / abort / onProgress / 错误码规范化
// - 错误码：PERMISSION_DENIED / ABORTED / DOMAIN_ERROR
// - 行为保真：legacy 输出（含 STATUS_ICONS / "No planning service available." /
//   "No plan exists yet." / Summary mode / Full plan output）1:1 复刻
//
// Opaque service handle 模式：
//   ctx.planningService 用 cast: `ctx.planningService as PlanningService`。
//   缺 service 时按 legacy 行为 → 返回成功 + 提示文案（向后兼容评测集）。
// ============================================================================

import type {
  ToolHandler,
  ToolModule,
  ToolContext,
  CanUseToolFn,
  ToolProgressFn,
  ToolResult,
} from '../../../protocol/tools';
import type { PlanningService } from '../../../planning';
import { planReadSchema as schema } from './planRead.schema';

// Status icons (与 legacy 保持一致)
const STATUS_ICONS = {
  pending: '○',
  in_progress: '◐',
  completed: '●',
  blocked: '✖',
  skipped: '⊘',
} as const;

export async function executePlanRead(
  args: Record<string, unknown>,
  ctx: ToolContext,
  canUseTool: CanUseToolFn,
  onProgress?: ToolProgressFn,
): Promise<ToolResult<string>> {
  const includeCompleted = (args.includeCompleted as boolean) || false;
  const summary = (args.summary as boolean) || false;

  const permit = await canUseTool(schema.name, args);
  if (!permit.allow) {
    return { ok: false, error: `permission denied: ${permit.reason}`, code: 'PERMISSION_DENIED' };
  }
  if (ctx.abortSignal.aborted) {
    return { ok: false, error: 'aborted', code: 'ABORTED' };
  }

  onProgress?.({ stage: 'starting', detail: schema.name });

  const planningService = ctx.planningService as PlanningService | undefined;

  if (!planningService) {
    onProgress?.({ stage: 'completing', percent: 100 });
    return {
      ok: true,
      output:
        'No planning service available.\n' +
        'To create a plan, use plan_update tool.',
    };
  }

  try {
    const plan = await planningService.plan.read();

    if (!plan) {
      onProgress?.({ stage: 'completing', percent: 100 });
      return {
        ok: true,
        output:
          'No plan exists yet.\n' +
          'To create a plan, use plan_update tool.',
      };
    }

    // Summary mode
    if (summary) {
      const current = planningService.plan.getCurrentTask();
      const next = planningService.plan.getNextPendingTask();

      let output = `**${plan.title}**\n`;
      output += `Progress: ${plan.metadata.completedSteps}/${plan.metadata.totalSteps} steps\n\n`;

      if (current) {
        output += `Current: ${current.step.content}\n`;
      } else if (next) {
        output += `Next: ${next.step.content}\n`;
      } else if (planningService.plan.isComplete()) {
        output += `Status: All tasks completed!\n`;
      }

      onProgress?.({ stage: 'completing', percent: 100 });
      ctx.logger.debug('plan_read done', { mode: 'summary' });
      return { ok: true, output };
    }

    // Full plan output
    let output = `# ${plan.title}\n\n`;
    output += `**Objective:** ${plan.objective}\n`;
    output += `**Progress:** ${plan.metadata.completedSteps}/${plan.metadata.totalSteps} steps completed\n`;

    if (plan.metadata.blockedSteps > 0) {
      output += `**Skipped:** ${plan.metadata.blockedSteps} steps\n`;
    }

    output += `\n---\n\n`;

    for (const phase of plan.phases) {
      const phaseIcon = STATUS_ICONS[phase.status];
      output += `## ${phaseIcon} ${phase.title}\n\n`;

      if (phase.notes) {
        output += `> ${phase.notes}\n\n`;
      }

      for (const step of phase.steps) {
        // Skip completed steps if not requested
        if (!includeCompleted && step.status === 'completed') {
          continue;
        }

        const stepIcon = STATUS_ICONS[step.status];
        const marker = step.status === 'completed' ? '[x]' : '[ ]';
        output += `- ${marker} ${stepIcon} ${step.content}\n`;
      }

      output += '\n';
    }

    // Add current task highlight
    const current = planningService.plan.getCurrentTask();
    if (current) {
      output += `---\n\n`;
      output += `**Current Task:** ${current.step.content}\n`;
    }

    onProgress?.({ stage: 'completing', percent: 100 });
    ctx.logger.debug('plan_read done', { mode: 'full' });
    return { ok: true, output };
  } catch (error) {
    return {
      ok: false,
      error: `Failed to read plan: ${error instanceof Error ? error.message : 'Unknown error'}`,
      code: 'DOMAIN_ERROR',
    };
  }
}

class PlanReadHandler implements ToolHandler<Record<string, unknown>, string> {
  readonly schema = schema;
  async execute(
    args: Record<string, unknown>,
    ctx: ToolContext,
    canUseTool: CanUseToolFn,
    onProgress?: ToolProgressFn,
  ): Promise<ToolResult<string>> {
    return executePlanRead(args, ctx, canUseTool, onProgress);
  }
}

export const planReadModule: ToolModule<Record<string, unknown>, string> = {
  schema,
  createHandler() {
    return new PlanReadHandler();
  },
};
