// Schema-only file (P1 Wave 3 — planning native migration)
import type { ToolSchema } from '../../../protocol/tools';

/**
 * 证据门参数（ADR-050）。task_update 和 TaskManager 的 update/replace/patch
 * 共用同一份定义——三处各写一遍迟早漏一处，模型就从那条路径绕过证据要求。
 */
export const TASK_EVIDENCE_PROPERTIES = {
  completionEvidence: {
    type: 'string',
    description:
      'Required when status="completed". What you actually verified, in one line: the command you ran '
      + 'and its result, the file you re-read, the page you observed. '
      + 'If a subagent reported success, verify it yourself first — its report is not evidence. '
      + 'Task status is advisory; it never overrides real filesystem/git/test results.',
  },
  blockedReason: {
    type: 'string',
    description:
      'Required when status="blocked". Plain-language description of what is blocking the work '
      + '(e.g. "the site requires a login we do not have"). Do not paste raw error logs or API responses.',
  },
  cancelReason: {
    type: 'string',
    description: 'Recommended when status="cancelled": why the task was abandoned.',
  },
} as const;

export const TASK_STATUS_DESCRIPTION =
  'New status for the task. Use "blocked" when an external obstacle stops the work (requires blockedReason); '
  + 'use "cancelled" to abandon but keep it visible (struck through); '
  + 'use "deleted" to permanently remove the task. '
  + '"completed" requires completionEvidence.';

export const taskUpdateSchema: ToolSchema = {
  name: 'task_update',
  description:
    'Update a semantic work-unit task\'s status, details, or dependencies. ' +
    'Keep task titles user-visible and outcome-oriented; do not rename tasks to raw tool operations. ' +
    'Set status="blocked" (with blockedReason) when something external stops the work; ' +
    'set status="cancelled" to abandon a task while keeping it visible; ' +
    'set status="deleted" to permanently remove a task. ' +
    'Completing a task requires completionEvidence. ' +
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
        enum: ['pending', 'in_progress', 'completed', 'blocked', 'cancelled', 'deleted'],
        description: TASK_STATUS_DESCRIPTION,
      },
      ...TASK_EVIDENCE_PROPERTIES,
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
