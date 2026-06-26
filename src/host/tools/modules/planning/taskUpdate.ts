// ============================================================================
// TaskUpdate (P1 Wave 3 — planning: native ToolModule rewrite)
//
// 旧版: src/main/tools/planning/taskUpdate.ts
// 改造点：
// - 4 参数签名 (args, ctx, canUseTool, onProgress)
// - 五链 + 错误码：INVALID_ARGS / PERMISSION_DENIED / ABORTED / NOT_FOUND /
//   DOMAIN_ERROR
// - 行为保真：
//   * desktopAction 校验 (5 valid / 仅 desktop-derived)
//   * addBlockedBy / addBlocks task ID 存在性校验
//   * desktopAction 生命周期 (accept/dismiss/snooze/reopen/supersede)
//   * status='deleted' 走 isDelete 分支 + lifecycle 用 existingTask
//   * snoozeHours 计算 + reason 字段 + ctx.emit('task_update', ...)
//   * 输出文案 1:1（changes 列表 / "deleted successfully"）
// ============================================================================

import type {
  ToolHandler,
  ToolModule,
  ToolContext,
  CanUseToolFn,
  ToolProgressFn,
  ToolResult,
} from '../../../protocol/tools';
import {
  getDesktopActivityUnderstandingService,
  isDesktopDerivedSessionTask,
} from '../../../desktop/desktopActivityUnderstandingService';
import { updateTask, getTask, listTasks } from '../../../services/planning/taskStore';
import { taskUpdateSchema as schema } from './taskUpdate.schema';

const VALID_DESKTOP_ACTIONS = ['accept', 'dismiss', 'snooze', 'reopen', 'supersede'] as const;
type DesktopAction = (typeof VALID_DESKTOP_ACTIONS)[number];

export async function executeTaskUpdate(
  args: Record<string, unknown>,
  ctx: ToolContext,
  canUseTool: CanUseToolFn,
  onProgress?: ToolProgressFn,
): Promise<ToolResult<string>> {
  const taskId = args.taskId;
  if (typeof taskId !== 'string' || !taskId) {
    return {
      ok: false,
      error: 'taskId is required and must be a string',
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

  onProgress?.({ stage: 'starting', detail: schema.name });

  const sessionId = ctx.sessionId || 'default';

  const existingTask = getTask(sessionId, taskId);
  if (!existingTask) {
    const allTasks = listTasks(sessionId);
    const availableIds = allTasks.map((t) => t.id).join(', ') || 'none';
    return {
      ok: false,
      error: `Task #${taskId} not found. Available task IDs: ${availableIds}`,
      code: 'NOT_FOUND',
    };
  }

  const desktopAction = args.desktopAction as string | undefined;
  if (desktopAction && !VALID_DESKTOP_ACTIONS.includes(desktopAction as DesktopAction)) {
    return {
      ok: false,
      error: `Invalid desktopAction: ${desktopAction}. Must be one of: ${VALID_DESKTOP_ACTIONS.join(', ')}`,
      code: 'INVALID_ARGS',
    };
  }
  if (desktopAction && !isDesktopDerivedSessionTask(existingTask)) {
    return {
      ok: false,
      error: 'desktopAction can only be used with desktop-derived tasks',
      code: 'INVALID_ARGS',
    };
  }

  const updates: Record<string, unknown> = {};
  if (args.status !== undefined) updates.status = args.status;
  if (args.subject !== undefined) updates.subject = args.subject;
  if (args.description !== undefined) updates.description = args.description;
  if (args.activeForm !== undefined) updates.activeForm = args.activeForm;
  if (args.owner !== undefined) updates.owner = args.owner;
  if (args.addBlockedBy !== undefined) updates.addBlockedBy = args.addBlockedBy;
  if (args.addBlocks !== undefined) updates.addBlocks = args.addBlocks;
  if (args.metadata !== undefined) updates.metadata = args.metadata;

  if (updates.addBlockedBy) {
    const allTasks = listTasks(sessionId);
    const taskIds = new Set(allTasks.map((t) => t.id));
    for (const depId of updates.addBlockedBy as string[]) {
      if (!taskIds.has(depId)) {
        return {
          ok: false,
          error: `Cannot add dependency: Task #${depId} does not exist`,
          code: 'INVALID_ARGS',
        };
      }
    }
  }
  if (updates.addBlocks) {
    const allTasks = listTasks(sessionId);
    const taskIds = new Set(allTasks.map((t) => t.id));
    for (const depId of updates.addBlocks as string[]) {
      if (!taskIds.has(depId)) {
        return {
          ok: false,
          error: `Cannot add dependency: Task #${depId} does not exist`,
          code: 'INVALID_ARGS',
        };
      }
    }
  }

  const isDelete = args.status === 'deleted';
  const updatedTask = updateTask(sessionId, taskId, updates);

  if (!updatedTask) {
    return {
      ok: false,
      error: `Failed to update task #${taskId}`,
      code: 'DOMAIN_ERROR',
    };
  }

  try {
    const desktopActivity = getDesktopActivityUnderstandingService();
    const lifecycleTask = isDelete ? existingTask : updatedTask;

    if (desktopAction && isDesktopDerivedSessionTask(lifecycleTask)) {
      const snoozeHours = Math.max(1, Number(args.desktopSnoozeHours || 24));
      if (desktopAction === 'reopen') {
        desktopActivity.clearTodoFeedbackForTask(lifecycleTask);
      } else {
        const statusByAction = {
          accept: 'accepted',
          dismiss: 'dismissed',
          snooze: 'snoozed',
          supersede: 'superseded',
        } as const;
        const feedbackStatus = statusByAction[desktopAction as keyof typeof statusByAction];
        if (feedbackStatus) {
          desktopActivity.recordTodoFeedbackForTask(lifecycleTask, feedbackStatus, {
            sessionId,
            source: 'task',
            ...(desktopAction === 'snooze'
              ? {
                  resumeAtMs: Date.now() + snoozeHours * 60 * 60 * 1000,
                  reason: `task_update:snooze:${snoozeHours}h`,
                }
              : undefined),
            ...(desktopAction === 'supersede'
              ? {
                  reason: 'task_update:supersede',
                }
              : undefined),
          });
        }
      }
    } else if (
      (args.status === 'completed' || args.status === 'cancelled' || args.status === 'deleted') &&
      isDesktopDerivedSessionTask(lifecycleTask)
    ) {
      desktopActivity.recordTodoFeedbackForTask(
        lifecycleTask,
        args.status === 'completed' ? 'completed' : 'dismissed',
        { sessionId, source: 'task' },
      );
    } else if (args.status === 'in_progress' && isDesktopDerivedSessionTask(updatedTask)) {
      desktopActivity.recordTodoFeedbackForTask(updatedTask, 'accepted', {
        sessionId,
        source: 'task',
      });
    } else if (args.status === 'pending' && isDesktopDerivedSessionTask(updatedTask)) {
      desktopActivity.clearTodoFeedbackForTask(updatedTask);
    }
  } catch {
    // Lifecycle feedback is best-effort and should not block task updates.
  }

  // 行为保真：legacy ctx.emit('task_update', ...)
  (ctx.emit as unknown as ((event: string, payload: unknown) => void) | undefined)?.(
    'task_update',
    {
      tasks: listTasks(sessionId),
      action: isDelete ? 'delete' : 'update',
      taskId,
    },
  );

  if (isDelete) {
    onProgress?.({ stage: 'completing', percent: 100 });
    return {
      ok: true,
      output: `Task #${taskId} deleted successfully.`,
      meta: { deleted: true, taskId },
    };
  }

  const changes: string[] = [];
  if (args.status !== undefined) changes.push(`status → ${args.status}`);
  if (args.subject !== undefined) changes.push(`subject updated`);
  if (args.description !== undefined) changes.push(`description updated`);
  if (args.activeForm !== undefined) changes.push(`activeForm updated`);
  if (args.owner !== undefined) changes.push(`owner → ${args.owner || '(unassigned)'}`);
  if (args.addBlockedBy !== undefined)
    changes.push(`added blockedBy: ${(args.addBlockedBy as string[]).join(', ')}`);
  if (args.addBlocks !== undefined)
    changes.push(`added blocks: ${(args.addBlocks as string[]).join(', ')}`);
  if (args.metadata !== undefined) changes.push(`metadata merged`);
  if (desktopAction !== undefined) changes.push(`desktopAction → ${desktopAction}`);

  onProgress?.({ stage: 'completing', percent: 100 });
  ctx.logger.debug('task_update done', { taskId });

  return {
    ok: true,
    output:
      `Task #${taskId} updated:\n` +
      `  Subject: ${updatedTask.subject}\n` +
      `  Status: ${updatedTask.status}\n` +
      (changes.length > 0 ? `  Changes: ${changes.join(', ')}` : ''),
    meta: { task: updatedTask },
  };
}

class TaskUpdateHandler implements ToolHandler<Record<string, unknown>, string> {
  readonly schema = schema;
  async execute(
    args: Record<string, unknown>,
    ctx: ToolContext,
    canUseTool: CanUseToolFn,
    onProgress?: ToolProgressFn,
  ): Promise<ToolResult<string>> {
    return executeTaskUpdate(args, ctx, canUseTool, onProgress);
  }
}

export const taskUpdateModule: ToolModule<Record<string, unknown>, string> = {
  schema,
  createHandler() {
    return new TaskUpdateHandler();
  },
};
