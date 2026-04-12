// ============================================================================
// Task Update Tool - Update or delete a task (Claude Code 2.x compatible)
// ============================================================================

import type { Tool, ToolContext, ToolExecutionResult } from '../types';
import { getDesktopActivityUnderstandingService, isDesktopDerivedSessionTask } from '../../desktop/desktopActivityUnderstandingService';
import { updateTask, getTask, listTasks } from '../../services/planning/taskStore';

export const taskUpdateTool: Tool = {
  name: 'task_update',
  description:
    'Update a task\'s status, details, or dependencies. ' +
    'Set status="deleted" to permanently remove a task. ' +
    'Use addBlockedBy/addBlocks to establish task dependencies.',
  requiresPermission: false,
  permissionLevel: 'read',
  inputSchema: {
    type: 'object',
    properties: {
      taskId: {
        type: 'string',
        description: 'The ID of the task to update',
      },
      status: {
        type: 'string',
        enum: ['pending', 'in_progress', 'completed', 'deleted'],
        description:
          'New status for the task. Use "deleted" to permanently remove the task.',
      },
      subject: {
        type: 'string',
        description: 'New subject for the task',
      },
      description: {
        type: 'string',
        description: 'New description for the task',
      },
      activeForm: {
        type: 'string',
        description: 'Present continuous form shown in spinner when in_progress',
      },
      owner: {
        type: 'string',
        description: 'New owner for the task (agent name)',
      },
      addBlockedBy: {
        type: 'array',
        items: { type: 'string' },
        description: 'Task IDs that block this task (must complete first)',
      },
      addBlocks: {
        type: 'array',
        items: { type: 'string' },
        description: 'Task IDs that this task blocks',
      },
      metadata: {
        type: 'object',
        description: 'Metadata keys to merge into the task. Set a key to null to delete it.',
      },
      desktopAction: {
        type: 'string',
        enum: ['accept', 'dismiss', 'snooze', 'reopen', 'supersede'],
        description: 'Optional lifecycle action for desktop-derived tasks.',
      },
      desktopSnoozeHours: {
        type: 'number',
        description: 'When desktopAction="snooze", suppress recovery for this many hours (default: 24).',
      },
    },
    required: ['taskId'],
  },

  async execute(
    params: Record<string, unknown>,
    context: ToolContext
  ): Promise<ToolExecutionResult> {
    const taskId = params.taskId as string;

    if (!taskId || typeof taskId !== 'string') {
      return {
        success: false,
        error: 'taskId is required and must be a string',
      };
    }

    // Get sessionId from context
    const sessionId = (context as unknown as { sessionId?: string }).sessionId || 'default';

    // Check if task exists
    const existingTask = getTask(sessionId, taskId);
    if (!existingTask) {
      const allTasks = listTasks(sessionId);
      const availableIds = allTasks.map((t) => t.id).join(', ') || 'none';
      return {
        success: false,
        error: `Task #${taskId} not found. Available task IDs: ${availableIds}`,
      };
    }

    const desktopAction = params.desktopAction as string | undefined;
    const validDesktopActions = ['accept', 'dismiss', 'snooze', 'reopen', 'supersede'];
    if (desktopAction && !validDesktopActions.includes(desktopAction)) {
      return {
        success: false,
        error: `Invalid desktopAction: ${desktopAction}. Must be one of: ${validDesktopActions.join(', ')}`,
      };
    }
    if (desktopAction && !isDesktopDerivedSessionTask(existingTask)) {
      return {
        success: false,
        error: 'desktopAction can only be used with desktop-derived tasks',
      };
    }

    // Build update object
    const updates: Record<string, unknown> = {};

    if (params.status !== undefined) updates.status = params.status;
    if (params.subject !== undefined) updates.subject = params.subject;
    if (params.description !== undefined) updates.description = params.description;
    if (params.activeForm !== undefined) updates.activeForm = params.activeForm;
    if (params.owner !== undefined) updates.owner = params.owner;
    if (params.addBlockedBy !== undefined) updates.addBlockedBy = params.addBlockedBy;
    if (params.addBlocks !== undefined) updates.addBlocks = params.addBlocks;
    if (params.metadata !== undefined) updates.metadata = params.metadata;

    // Validate addBlockedBy task IDs exist
    if (updates.addBlockedBy) {
      const allTasks = listTasks(sessionId);
      const taskIds = new Set(allTasks.map((t) => t.id));
      for (const depId of updates.addBlockedBy as string[]) {
        if (!taskIds.has(depId)) {
          return {
            success: false,
            error: `Cannot add dependency: Task #${depId} does not exist`,
          };
        }
      }
    }

    // Validate addBlocks task IDs exist
    if (updates.addBlocks) {
      const allTasks = listTasks(sessionId);
      const taskIds = new Set(allTasks.map((t) => t.id));
      for (const depId of updates.addBlocks as string[]) {
        if (!taskIds.has(depId)) {
          return {
            success: false,
            error: `Cannot add dependency: Task #${depId} does not exist`,
          };
        }
      }
    }

    const isDelete = params.status === 'deleted';
    const updatedTask = updateTask(sessionId, taskId, updates);

    if (!updatedTask) {
      return {
        success: false,
        error: `Failed to update task #${taskId}`,
      };
    }

    try {
      const desktopActivity = getDesktopActivityUnderstandingService();
      const lifecycleTask = isDelete ? existingTask : updatedTask;

      if (desktopAction && isDesktopDerivedSessionTask(lifecycleTask)) {
        const snoozeHours = Math.max(1, Number(params.desktopSnoozeHours || 24));
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
            desktopActivity.recordTodoFeedbackForTask(
              lifecycleTask,
              feedbackStatus,
              {
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
              },
            );
          }
        }
      } else if ((params.status === 'completed' || params.status === 'deleted') && isDesktopDerivedSessionTask(lifecycleTask)) {
        desktopActivity.recordTodoFeedbackForTask(
          lifecycleTask,
          params.status === 'completed' ? 'completed' : 'dismissed',
          { sessionId, source: 'task' },
        );
      } else if (params.status === 'in_progress' && isDesktopDerivedSessionTask(updatedTask)) {
        desktopActivity.recordTodoFeedbackForTask(
          updatedTask,
          'accepted',
          { sessionId, source: 'task' },
        );
      } else if (params.status === 'pending' && isDesktopDerivedSessionTask(updatedTask)) {
        desktopActivity.clearTodoFeedbackForTask(updatedTask);
      }
    } catch {
      // Lifecycle feedback is best-effort and should not block task updates.
    }

    // Emit task update event
    if (context.emit) {
      context.emit('task_update', {
        tasks: listTasks(sessionId),
        action: isDelete ? 'delete' : 'update',
        taskId: taskId,
      });
    }

    if (isDelete) {
      return {
        success: true,
        output: `Task #${taskId} deleted successfully.`,
        metadata: { deleted: true, taskId },
      };
    }

    // Build change summary
    const changes: string[] = [];
    if (params.status !== undefined) changes.push(`status → ${params.status}`);
    if (params.subject !== undefined) changes.push(`subject updated`);
    if (params.description !== undefined) changes.push(`description updated`);
    if (params.activeForm !== undefined) changes.push(`activeForm updated`);
    if (params.owner !== undefined) changes.push(`owner → ${params.owner || '(unassigned)'}`);
    if (params.addBlockedBy !== undefined)
      changes.push(`added blockedBy: ${(params.addBlockedBy as string[]).join(', ')}`);
    if (params.addBlocks !== undefined)
      changes.push(`added blocks: ${(params.addBlocks as string[]).join(', ')}`);
    if (params.metadata !== undefined) changes.push(`metadata merged`);
    if (desktopAction !== undefined) changes.push(`desktopAction → ${desktopAction}`);

    return {
      success: true,
      output:
        `Task #${taskId} updated:\n` +
        `  Subject: ${updatedTask.subject}\n` +
        `  Status: ${updatedTask.status}\n` +
        (changes.length > 0 ? `  Changes: ${changes.join(', ')}` : ''),
      metadata: { task: updatedTask },
    };
  },
};
