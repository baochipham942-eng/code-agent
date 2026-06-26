// ============================================================================
// PlanRecoverRecentWork (P1 Wave 3 — planning: native ToolModule rewrite)
//
// 旧版: src/host/tools/planning/planRecoverRecentWork.ts
// 改造点：
// - 4 参数签名 (args, ctx, canUseTool, onProgress)
// - 五链 + 错误码：PERMISSION_DENIED / ABORTED / NOT_INITIALIZED / DOMAIN_ERROR
// - 行为保真：legacy 输出（"Recovered recent work signals into planning." +
//   Desktop / Planning bridge / Workspace 行）1:1 复刻
//
// Opaque service handle：
//   ctx.planningService cast `as PlanningService`。缺 → NOT_INITIALIZED。
//   保留 legacy emit('task_update', ...) 通过 ctx.emit 透传 — protocol AgentEvent
//   类型不限制 emit shape，按 legacy {type, data} 形态发即可。
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
import {
  publishPlanningStateToRenderer,
} from '../../../planning';
import { recoverRecentWorkIntoPlanning } from '../../../planning/recoveredWorkOrchestrator';
import { planRecoverRecentWorkSchema as schema } from './planRecoverRecentWork.schema';

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

export async function executePlanRecoverRecentWork(
  args: Record<string, unknown>,
  ctx: ToolContext,
  canUseTool: CanUseToolFn,
  onProgress?: ToolProgressFn,
): Promise<ToolResult<string>> {
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
    return {
      ok: false,
      error: 'Planning service not available.',
      code: 'NOT_INITIALIZED',
    };
  }

  try {
    const sessionId = ctx.sessionId || 'default';
    const result = await recoverRecentWorkIntoPlanning({
      planningService,
      sessionId,
      query: asString(args.query),
      sinceHours: asNumber(args.sinceHours),
      desktopLimit: asNumber(args.desktopLimit),
      workspaceLimit: asNumber(args.workspaceLimit),
      refreshDesktop: asBoolean(args.refreshDesktop),
      refreshArtifacts: asBoolean(args.refreshArtifacts),
    });

    if (result.taskSync.created.length > 0 || result.taskSync.updated.length > 0) {
      // 行为保真：legacy 通过 context.emit?.('task_update', ...) 触发 sync 事件
      // protocol ctx.emit 接受 AgentEvent；这里按 legacy shape 透传，下游分发
      // 不变（renderer 按 channel 名匹配）。
      (ctx.emit as unknown as ((event: string, payload: unknown) => void) | undefined)?.(
        'task_update',
        {
          tasks: result.taskSync.tasks,
          action: 'sync',
          taskIds: [
            ...result.taskSync.created.map((task) => task.id),
            ...result.taskSync.updated.map((task) => task.id),
          ],
          source: 'recovered_work',
        },
      );
    }

    if (result.planChanged) {
      await publishPlanningStateToRenderer(planningService);
    }

    const lines = [
      'Recovered recent work signals into planning.',
      `Desktop-derived tasks: ${result.taskSync.totalCandidates} candidates, ${result.taskSync.created.length} created, ${result.taskSync.updated.length} updated.`,
      `Planning bridge: ${result.planningSync.addedSteps.length} steps added, ${result.planningSync.updatedSteps.length} steps updated.`,
    ];

    if (result.workspaceResult) {
      lines.push(
        `Workspace matches: ${result.workspaceResult.items.length} relevant merged items${result.workspaceResult.warnings.length > 0 ? ` (${result.workspaceResult.warnings.length} warnings)` : ''}.`,
      );
    }

    if (result.createdWorkspacePhase) {
      lines.push('Added a dedicated "Recovered Workspace Activity" phase.');
    } else if (result.createdWorkspaceReviewStep) {
      lines.push('Added a lightweight workspace review step to the existing recovery phase.');
    }

    if (result.updatedWorkspaceNotes) {
      lines.push('Updated plan notes with recovered workspace evidence.');
    }

    if (!result.planChanged && (!result.workspaceResult || result.workspaceResult.items.length === 0)) {
      lines.push('No additional planning mutations were needed.');
    }

    onProgress?.({ stage: 'completing', percent: 100 });
    ctx.logger.debug('plan_recover_recent_work done', {
      created: result.taskSync.created.length,
      updated: result.taskSync.updated.length,
    });

    return {
      ok: true,
      output: lines.join('\n'),
      meta: {
        taskCandidates: result.taskSync.totalCandidates,
        createdTasks: result.taskSync.created.length,
        updatedTasks: result.taskSync.updated.length,
        addedPlanSteps: result.planningSync.addedSteps.length,
        updatedPlanSteps: result.planningSync.updatedSteps.length,
        workspaceMatches: result.workspaceResult?.items.length || 0,
        planChanged: result.planChanged,
      },
    };
  } catch (error) {
    return {
      ok: false,
      error: `Failed to recover recent work: ${error instanceof Error ? error.message : 'Unknown error'}`,
      code: 'DOMAIN_ERROR',
    };
  }
}

class PlanRecoverRecentWorkHandler implements ToolHandler<Record<string, unknown>, string> {
  readonly schema = schema;
  async execute(
    args: Record<string, unknown>,
    ctx: ToolContext,
    canUseTool: CanUseToolFn,
    onProgress?: ToolProgressFn,
  ): Promise<ToolResult<string>> {
    return executePlanRecoverRecentWork(args, ctx, canUseTool, onProgress);
  }
}

export const planRecoverRecentWorkModule: ToolModule<Record<string, unknown>, string> = {
  schema,
  createHandler() {
    return new PlanRecoverRecentWorkHandler();
  },
};
