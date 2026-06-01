// Schema-only file (P1 Wave 3 — planning native migration)
import type { ToolSchema } from '../../../protocol/tools';

export const taskUpdateSchema: ToolSchema = {
  name: 'task_update',
  description:
    'Update a semantic work-unit task\'s status, details, or dependencies. ' +
    'Keep task titles user-visible and outcome-oriented; do not rename tasks to raw tool operations. ' +
    'Set status="cancelled" to abandon a task while keeping it visible; ' +
    'set status="deleted" to permanently remove a task. ' +
    'Use addBlockedBy/addBlocks to establish task dependencies.',
  inputSchema: {
    type: 'object',
    properties: {
      taskId: {
        type: 'string',
        description: 'The ID of the task to update',
      },
      status: {
        type: 'string',
        enum: ['pending', 'in_progress', 'completed', 'cancelled', 'deleted'],
        description:
          'New status for the task. Use "cancelled" to abandon but keep it visible (struck through); '
          + 'use "deleted" to permanently remove the task.',
      },
      subject: {
        type: 'string',
        description:
          'New semantic subject for the task. Describe the work goal or outcome, not a raw tool action like "Read file".',
      },
      description: {
        type: 'string',
        description: 'New user-visible purpose and completion criteria for this work unit',
      },
      activeForm: {
        type: 'string',
        description:
          'Present continuous semantic form shown in spinner when in_progress; avoid raw tool actions like "Writing file".',
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
  category: 'planning',
  permissionLevel: 'write',
  allowInPlanMode: true,
};
