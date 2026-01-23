// ============================================================================
// Todo Write Tool - Track task progress with optional persistence
// ============================================================================

import type { Tool, ToolContext, ToolExecutionResult } from '../toolRegistry';
import type { TodoItem, TodoStatus } from '../../../shared/types';
import type { PlanningService } from '../../planning';
import { createLogger } from '../../services/infra/logger';

const logger = createLogger('TodoWrite');

// Session-scoped todo state (Map<sessionId, TodoItem[]>)
// Fix: Use per-session storage to prevent cross-session pollution
const sessionTodos: Map<string, TodoItem[]> = new Map();

// Get todos for a specific session (or global fallback)
function getSessionTodos(sessionId?: string): TodoItem[] {
  if (sessionId && sessionTodos.has(sessionId)) {
    return sessionTodos.get(sessionId)!;
  }
  return [];
}

// Set todos for a specific session
function setSessionTodos(sessionId: string | undefined, todos: TodoItem[]): void {
  if (sessionId) {
    sessionTodos.set(sessionId, todos);
  }
}

// Status icons
const STATUS_ICONS: Record<TodoStatus, string> = {
  pending: '○',
  in_progress: '◐',
  completed: '●',
};

export const todoWriteTool: Tool = {
  name: 'todo_write',
  description:
    'Create or update a todo list to track task progress. ' +
    'Set persist=true to save to task_plan.md file for long-term tracking across sessions.',
  generations: ['gen3', 'gen4', 'gen5', 'gen6', 'gen7', 'gen8'],
  requiresPermission: false,
  permissionLevel: 'read',
  inputSchema: {
    type: 'object',
    properties: {
      todos: {
        type: 'array',
        description: 'Array of todo items',
        items: {
          type: 'object',
          properties: {
            content: {
              type: 'string',
              description: 'Task description',
            },
            status: {
              type: 'string',
              description: 'Task status: pending, in_progress, or completed',
              enum: ['pending', 'in_progress', 'completed'],
            },
            activeForm: {
              type: 'string',
              description:
                'Present continuous form of the task (e.g., "Running tests")',
            },
            phaseId: {
              type: 'string',
              description:
                'Phase ID to update in persistent plan (optional, for updating existing plans)',
            },
          },
        },
      },
      persist: {
        type: 'boolean',
        description:
          'Save to task_plan.md file for persistent tracking (default: false)',
        default: false,
      },
      planTitle: {
        type: 'string',
        description:
          'Title for the plan (required when persist=true for new plans)',
      },
      planObjective: {
        type: 'string',
        description:
          'Objective/goal for the plan (optional, used when creating new plans)',
      },
    },
    required: ['todos'],
  },

  async execute(
    params: Record<string, unknown>,
    context: ToolContext
  ): Promise<ToolExecutionResult> {
    const todos = params.todos as Array<{
      content: string;
      status: TodoStatus;
      activeForm: string;
      phaseId?: string;
    }>;
    const persist = (params.persist as boolean) || false;
    const planTitle = params.planTitle as string | undefined;
    const planObjective = params.planObjective as string | undefined;

    // Validate todos array
    if (!Array.isArray(todos)) {
      return {
        success: false,
        error: 'todos must be an array',
      };
    }

    // Validate each todo item
    for (const todo of todos) {
      if (!todo.content || !todo.status || !todo.activeForm) {
        return {
          success: false,
          error: 'Each todo must have content, status, and activeForm',
        };
      }

      if (!['pending', 'in_progress', 'completed'].includes(todo.status)) {
        return {
          success: false,
          error: `Invalid status: ${todo.status}. Must be pending, in_progress, or completed`,
        };
      }
    }

    // Get sessionId from context (passed through AgentLoop)
    const sessionId = (context as unknown as { sessionId?: string }).sessionId;

    // Convert to TodoItem array
    const todoItems: TodoItem[] = todos.map((t) => ({
      content: t.content,
      status: t.status,
      activeForm: t.activeForm,
    }));

    // Update session-scoped todos (fix cross-session pollution)
    setSessionTodos(sessionId, todoItems);

    // Emit todo update event with sessionId
    // Frontend will filter events by sessionId
    if (context.emit) {
      context.emit('todo_update', todoItems);
    }

    // Handle persistence
    if (persist) {
      const planningService = context.planningService as PlanningService | undefined;

      if (!planningService) {
        // Gracefully fall back to non-persistent mode
        logger.info('Planning service not available, using in-memory mode');
        const formatted = formatTodoOutput(todoItems);
        const completed = todoItems.filter((t) => t.status === 'completed').length;
        const total = todoItems.length;

        return {
          success: true,
          output:
            `Todo list updated (${completed}/${total} completed) [in-memory mode]:\n${formatted}\n\n` +
            `Note: Planning service is not available. Todos are tracked in memory only.`,
        };
      }

      try {
        // Initialize planning service if needed
        await planningService.initialize();

        // Check for existing plan
        const existingPlan = await planningService.plan.read();

        if (existingPlan) {
          // Update existing plan
          // For simplicity, we update step statuses based on content matching
          for (const todo of todos) {
            for (const phase of existingPlan.phases) {
              const step = phase.steps.find((s) => s.content === todo.content);
              if (step) {
                const newStatus =
                  todo.status === 'completed'
                    ? 'completed'
                    : todo.status === 'in_progress'
                    ? 'in_progress'
                    : 'pending';

                if (step.status !== newStatus) {
                  await planningService.plan.updateStepStatus(
                    phase.id,
                    step.id,
                    newStatus
                  );
                }
              }
            }
          }

          const updatedPlan = await planningService.plan.read();
          const formatted = formatTodoOutput(todoItems);

          return {
            success: true,
            output:
              `Todo list updated and synced to task_plan.md ` +
              `(${updatedPlan?.metadata.completedSteps}/${updatedPlan?.metadata.totalSteps} completed):\n` +
              `${formatted}\n\n` +
              `Plan file: ${planningService.plan.getPlanPath()}`,
          };
        } else {
          // Create new plan
          if (!planTitle) {
            return {
              success: false,
              error:
                'planTitle is required when creating a new persistent plan. ' +
                'Provide a title that describes the overall task.',
            };
          }

          const newPlan = await planningService.plan.create({
            title: planTitle,
            objective: planObjective || 'Complete the tasks in the todo list',
            phases: [
              {
                id: `phase-${Date.now()}`,
                title: 'Main Tasks',
                status: 'pending',
                steps: todos.map((t) => ({
                  id: `step-${Date.now()}-${crypto.randomUUID().split('-')[0]}`,
                  content: t.content,
                  status:
                    t.status === 'completed'
                      ? 'completed'
                      : t.status === 'in_progress'
                      ? 'in_progress'
                      : 'pending',
                  activeForm: t.activeForm,
                })),
              },
            ],
          });

          const formatted = formatTodoOutput(todoItems);

          return {
            success: true,
            output:
              `Plan created and saved to task_plan.md:\n` +
              `Title: ${newPlan.title}\n` +
              `Objective: ${newPlan.objective}\n` +
              `Steps: ${newPlan.metadata.totalSteps}\n\n` +
              `${formatted}\n\n` +
              `Plan file: ${planningService.plan.getPlanPath()}`,
          };
        }
      } catch (error) {
        return {
          success: false,
          error: `Failed to persist plan: ${
            error instanceof Error ? error.message : 'Unknown error'
          }`,
        };
      }
    }

    // Non-persistent mode: just return formatted output
    const formatted = formatTodoOutput(todoItems);
    const completed = todoItems.filter((t) => t.status === 'completed').length;
    const total = todoItems.length;

    return {
      success: true,
      output: `Todo list updated (${completed}/${total} completed):\n${formatted}`,
    };
  },
};

// ----------------------------------------------------------------------------
// Helper Functions
// ----------------------------------------------------------------------------

function formatTodoOutput(todos: TodoItem[]): string {
  return todos.map((t) => `${STATUS_ICONS[t.status]} ${t.content}`).join('\n');
}

// Export function to get current todos for a session (for backward compatibility)
export function getCurrentTodos(sessionId?: string): TodoItem[] {
  return [...getSessionTodos(sessionId)];
}

// Export function to clear todos for a session
export function clearTodos(sessionId?: string): void {
  if (sessionId) {
    sessionTodos.delete(sessionId);
  } else {
    sessionTodos.clear();
  }
}
