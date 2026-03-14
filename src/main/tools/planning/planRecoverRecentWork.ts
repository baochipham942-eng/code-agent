import type { Tool, ToolContext, ToolExecutionResult } from '../types';
import {
  publishPlanningStateToRenderer,
  type PlanningService,
} from '../../planning';
import { recoverRecentWorkIntoPlanning } from '../../planning/recoveredWorkOrchestrator';

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

export const planRecoverRecentWorkTool: Tool = {
  name: 'plan_recover_recent_work',
  description:
    'Recover recent desktop/workspace-derived signals into the current plan. ' +
    'Use this when the user asks to continue previous work or when the next task is ambiguous.',
  requiresPermission: false,
  permissionLevel: 'read',
  inputSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Optional focused query used to pull merged workspace activity into the plan.',
      },
      sinceHours: {
        type: 'number',
        description: 'How far back to recover recent work signals. Default: 24.',
      },
      desktopLimit: {
        type: 'number',
        description: 'Maximum desktop-derived recovered tasks to sync. Default: 3.',
      },
      workspaceLimit: {
        type: 'number',
        description: 'Maximum merged workspace activity items to anchor into the plan. Default: 4.',
      },
      refreshDesktop: {
        type: 'boolean',
        description: 'If true or omitted, refresh desktop-derived signals before recovering them.',
      },
      refreshArtifacts: {
        type: 'boolean',
        description: 'If true, refresh indexed workspace artifacts before searching them.',
      },
    },
  },

  async execute(
    params: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolExecutionResult> {
    const planningService = context.planningService as PlanningService | undefined;
    if (!planningService) {
      return {
        success: false,
        error: 'Planning service not available.',
      };
    }

    const sessionId = context.sessionId || 'default';
    const result = await recoverRecentWorkIntoPlanning({
      planningService,
      sessionId,
      query: asString(params.query),
      sinceHours: asNumber(params.sinceHours),
      desktopLimit: asNumber(params.desktopLimit),
      workspaceLimit: asNumber(params.workspaceLimit),
      refreshDesktop: asBoolean(params.refreshDesktop),
      refreshArtifacts: asBoolean(params.refreshArtifacts),
    });

    if (result.taskSync.created.length > 0 || result.taskSync.updated.length > 0) {
      context.emit?.('task_update', {
        tasks: result.taskSync.tasks,
        action: 'sync',
        taskIds: [
          ...result.taskSync.created.map((task) => task.id),
          ...result.taskSync.updated.map((task) => task.id),
        ],
        source: 'recovered_work',
      });
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

    return {
      success: true,
      output: lines.join('\n'),
      result,
      metadata: {
        taskCandidates: result.taskSync.totalCandidates,
        createdTasks: result.taskSync.created.length,
        updatedTasks: result.taskSync.updated.length,
        addedPlanSteps: result.planningSync.addedSteps.length,
        updatedPlanSteps: result.planningSync.updatedSteps.length,
        workspaceMatches: result.workspaceResult?.items.length || 0,
        planChanged: result.planChanged,
      },
    };
  },
};
