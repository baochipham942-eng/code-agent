// ============================================================================
// Process Tool - Unified process management (Phase 2 consolidation)
// Merges: process_list, process_poll, process_log, process_write,
//         process_submit, process_kill, kill_shell, task_output
// ============================================================================

import type { Tool, ToolContext, ToolExecutionResult } from '../toolRegistry';
import {
  processListTool,
  processPollTool,
  processLogTool,
  processWriteTool,
  processSubmitTool,
  processKillTool,
} from './process';
import { killShellTool } from './killShell';
import { taskOutputTool } from './taskOutput';

export const ProcessTool: Tool = {
  name: 'Process',
  description: `Unified process management for background tasks and PTY sessions.

Actions:
- list: List all running/completed background processes and PTY sessions.
    Params: filter (optional, enum: all|running|completed|failed|pty|background)
- poll: Poll a process for new output since last poll.
    Params: session_id (required), block (optional bool), timeout (optional ms)
- log: Get the full log output from a process.
    Params: session_id (required), tail (optional number of lines)
- write: Write raw input to a PTY session (no newline appended).
    Params: session_id (required), data (required)
- submit: Submit a command to a PTY session (newline appended automatically).
    Params: session_id (required), input (required)
- kill: Terminate a running process. Accepts session_id or task_id (backward compat).
    Params: session_id or task_id (required)
- output: Get output from a background task. Accepts session_id or task_id (backward compat).
    Params: task_id or session_id (optional), block (optional bool, default true), timeout (optional ms)`,

  requiresPermission: true,
  permissionLevel: 'execute',

  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['list', 'poll', 'log', 'write', 'submit', 'kill', 'output'],
        description: 'The process management action to perform',
      },
      // list action
      filter: {
        type: 'string',
        enum: ['all', 'running', 'completed', 'failed', 'pty', 'background'],
        description: '[list] Filter processes by status or type (default: all)',
      },
      // poll, log, write, submit, kill actions
      session_id: {
        type: 'string',
        description: '[poll|log|write|submit|kill|output] The session/task ID',
      },
      // poll, output actions
      block: {
        type: 'boolean',
        description: '[poll] Wait for completion (default: false). [output] Wait for completion (default: true)',
      },
      timeout: {
        type: 'number',
        description: '[poll|output] Timeout in milliseconds when blocking (default: 30000)',
      },
      // log action
      tail: {
        type: 'number',
        description: '[log] Only return the last N lines',
      },
      // write action
      data: {
        type: 'string',
        description: '[write] Raw data to write (can include escape sequences)',
      },
      // submit action
      input: {
        type: 'string',
        description: '[submit] Command/input to submit (newline added automatically)',
      },
      // kill, output actions (backward compat with kill_shell and task_output)
      task_id: {
        type: 'string',
        description: '[kill|output] Alias for session_id (backward compat with kill_shell/task_output)',
      },
    },
    required: ['action'],
  },

  async execute(
    params: Record<string, unknown>,
    context: ToolContext
  ): Promise<ToolExecutionResult> {
    const action = params.action as string;

    switch (action) {
      case 'list':
        return processListTool.execute(params, context);

      case 'poll':
        return processPollTool.execute(params, context);

      case 'log':
        return processLogTool.execute(params, context);

      case 'write':
        return processWriteTool.execute(params, context);

      case 'submit':
        return processSubmitTool.execute(params, context);

      case 'kill': {
        // Support both session_id and task_id for backward compat with kill_shell
        const id = (params.session_id as string) || (params.task_id as string);
        if (!id) {
          return { success: false, error: 'session_id or task_id is required for kill action' };
        }
        // Try process_kill first (handles both PTY and background tasks)
        const killParams = { ...params, session_id: id };
        const result = await processKillTool.execute(killParams, context);
        if (result.success) return result;
        // Fallback to kill_shell for legacy background task handling
        return killShellTool.execute({ ...params, task_id: id }, context);
      }

      case 'output': {
        // Support both session_id and task_id for backward compat with task_output
        const outputId = (params.task_id as string) || (params.session_id as string);
        const outputParams = { ...params, task_id: outputId };
        return taskOutputTool.execute(outputParams, context);
      }

      default:
        return {
          success: false,
          error: `Unknown action: ${action}. Valid actions: list, poll, log, write, submit, kill, output`,
        };
    }
  },
};
