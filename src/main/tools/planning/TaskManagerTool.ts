// ============================================================================
// Task Manager Tool - Consolidates 4 task tools into 1 with action dispatch
// Phase 2: Tool Schema Consolidation (Group 3: 4->1)
// ============================================================================

import type { Tool, ToolContext, ToolExecutionResult } from '../types';
import { taskCreateTool } from './taskCreate';
import { taskGetTool } from './taskGet';
import { taskListTool } from './taskList';
import { taskUpdateTool } from './taskUpdate';

export const TaskManagerTool: Tool = {
  name: 'TaskManager',
  description: `Unified task management tool for creating, listing, retrieving, and updating session tasks.

Actions:
- create: Create a new task (requires subject, description; optional activeForm, priority, metadata)
- get: Get full details of a task by ID (requires taskId)
- list: List all tasks in the current session (no params needed)
- update: Update a task's status, details, or dependencies (requires taskId; optional status, subject, description, activeForm, owner, addBlockedBy, addBlocks, metadata). Set status="deleted" to remove a task.

Examples:
- Create: { "action": "create", "subject": "Implement login", "description": "Add OAuth login flow" }
- Get: { "action": "get", "taskId": "1" }
- List: { "action": "list" }
- Update status: { "action": "update", "taskId": "1", "status": "in_progress" }
- Add dependency: { "action": "update", "taskId": "2", "addBlockedBy": ["1"] }
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
        enum: ['pending', 'in_progress', 'completed', 'deleted'],
        description: '[update] New status. Use "deleted" to permanently remove the task.',
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
    },
    required: ['action'],
  },

  requiresPermission: false,
  permissionLevel: 'read',

  async execute(
    params: Record<string, unknown>,
    context: ToolContext
  ): Promise<ToolExecutionResult> {
    const action = params.action as string;

    switch (action) {
      case 'create':
        return taskCreateTool.execute(params, context);

      case 'get':
        return taskGetTool.execute(params, context);

      case 'list':
        return taskListTool.execute(params, context);

      case 'update':
        return taskUpdateTool.execute(params, context);

      default:
        return {
          success: false,
          error: `Unknown action: ${action}. Valid actions: create, get, list, update`,
        };
    }
  },
};
