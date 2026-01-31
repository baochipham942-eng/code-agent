// ============================================================================
// Task Create Tool - Create a new session task (Claude Code 2.x compatible)
// ============================================================================

import type { Tool, ToolContext, ToolExecutionResult } from '../toolRegistry';
import type { SessionTaskPriority } from '../../../shared/types/planning';
import { createTask, listTasks } from './taskStore';

export const taskCreateTool: Tool = {
  name: 'task_create',
  description:
    'Create a new task to track work progress. ' +
    'Use this for multi-step tasks that need progress tracking. ' +
    'Tasks are session-scoped and support dependencies via task_update.',
  generations: ['gen3', 'gen4', 'gen5', 'gen6', 'gen7', 'gen8'],
  requiresPermission: false,
  permissionLevel: 'read',
  inputSchema: {
    type: 'object',
    properties: {
      subject: {
        type: 'string',
        description: 'Brief task title in imperative form (e.g., "Implement login feature")',
      },
      description: {
        type: 'string',
        description: 'Detailed description of what needs to be done',
      },
      activeForm: {
        type: 'string',
        description:
          'Present continuous form shown while task is in progress ' +
          '(e.g., "Implementing login feature"). Auto-generated if not provided.',
      },
      priority: {
        type: 'string',
        enum: ['low', 'normal', 'high'],
        description: 'Task priority (default: normal)',
      },
      metadata: {
        type: 'object',
        description: 'Arbitrary metadata to attach to the task',
      },
    },
    required: ['subject', 'description'],
  },

  async execute(
    params: Record<string, unknown>,
    context: ToolContext
  ): Promise<ToolExecutionResult> {
    const subject = params.subject as string;
    const description = params.description as string;
    const activeForm = params.activeForm as string | undefined;
    const priority = (params.priority as SessionTaskPriority) || 'normal';
    const metadata = (params.metadata as Record<string, unknown>) || {};

    // Validate required fields
    if (!subject || typeof subject !== 'string') {
      return {
        success: false,
        error: 'subject is required and must be a string',
      };
    }

    if (!description || typeof description !== 'string') {
      return {
        success: false,
        error: 'description is required and must be a string',
      };
    }

    // Get sessionId from context
    const sessionId = (context as unknown as { sessionId?: string }).sessionId || 'default';

    // Create the task
    const task = createTask(sessionId, {
      subject,
      description,
      activeForm,
      priority,
      metadata,
    });

    // Emit task update event
    if (context.emit) {
      context.emit('task_update', {
        tasks: listTasks(sessionId),
        action: 'create',
        taskId: task.id,
      });
    }

    return {
      success: true,
      output:
        `Task #${task.id} created:\n` +
        `  Subject: ${task.subject}\n` +
        `  Status: ${task.status}\n` +
        `  Priority: ${task.priority}\n` +
        `  Active Form: ${task.activeForm}`,
      metadata: {
        taskId: task.id,
        task,
      },
    };
  },
};
