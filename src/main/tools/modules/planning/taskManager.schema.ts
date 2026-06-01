// Schema-only file (P1 Wave 3 — planning native migration)
import type { ToolSchema } from '../../../protocol/tools';

export const taskManagerSchema: ToolSchema = {
  name: 'TaskManager',
  description: `Unified task management tool for creating, listing, retrieving, and updating session tasks.

Actions:
- create: Create a new task (requires subject, description; optional activeForm, priority, metadata)
- get: Get full details of a task by ID (requires taskId)
- list: List all tasks in the current session (no params needed)
- update: Update a task's status, details, or dependencies (requires taskId; optional status, subject, description, activeForm, owner, addBlockedBy, addBlocks, metadata, desktopAction, desktopSnoozeHours). Set status="cancelled" to abandon a task while keeping it visible; set status="deleted" to remove a task.

Examples:
- Create: { "action": "create", "subject": "Implement login", "description": "Add OAuth login flow" }
- Get: { "action": "get", "taskId": "1" }
- List: { "action": "list" }
- Update status: { "action": "update", "taskId": "1", "status": "in_progress" }
- Cancel: { "action": "update", "taskId": "1", "status": "cancelled" }
- Add dependency: { "action": "update", "taskId": "2", "addBlockedBy": ["1"] }
- Snooze desktop task: { "action": "update", "taskId": "3", "desktopAction": "snooze", "desktopSnoozeHours": 24 }
- Delete: { "action": "update", "taskId": "1", "status": "deleted" }`,
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['create', 'get', 'list', 'update'],
        description: 'The task management action to perform',
      },
      // --- get / update params ---
      taskId: {
        type: 'string',
        description: '[get, update] The ID of the task',
      },
      // --- create / update params ---
      subject: {
        type: 'string',
        description: '[create, update] Brief task title in imperative form',
      },
      description: {
        type: 'string',
        description: '[create, update] Detailed description of what needs to be done',
      },
      activeForm: {
        type: 'string',
        description: '[create, update] Present continuous form shown while in progress (e.g., "Implementing login")',
      },
      // --- create only ---
      priority: {
        type: 'string',
        enum: ['low', 'normal', 'high'],
        description: '[create] Task priority (default: normal)',
      },
      // --- update only ---
      status: {
        type: 'string',
        enum: ['pending', 'in_progress', 'completed', 'cancelled', 'deleted'],
        description:
          '[update] New status. Use "cancelled" to abandon but keep it visible; '
          + 'use "deleted" to permanently remove the task.',
      },
      owner: {
        type: 'string',
        description: '[update] New owner for the task (agent name)',
      },
      addBlockedBy: {
        type: 'array',
        items: { type: 'string' },
        description: '[update] Task IDs that block this task (must complete first)',
      },
      addBlocks: {
        type: 'array',
        items: { type: 'string' },
        description: '[update] Task IDs that this task blocks',
      },
      // --- create / update ---
      metadata: {
        type: 'object',
        description: '[create, update] Arbitrary metadata. On update, keys are merged; set a key to null to delete it.',
      },
      desktopAction: {
        type: 'string',
        enum: ['accept', 'dismiss', 'snooze', 'reopen', 'supersede'],
        description: '[update] Optional lifecycle action for desktop-derived tasks.',
      },
      desktopSnoozeHours: {
        type: 'number',
        description: '[update] When desktopAction="snooze", suppress recovery for this many hours.',
      },
    },
    required: ['action'],
  },
  category: 'planning',
  permissionLevel: 'write',
  allowInPlanMode: true,
};
