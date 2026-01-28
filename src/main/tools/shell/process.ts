// ============================================================================
// Process Tool - Unified process management for background tasks and PTY sessions
// ============================================================================

import type { Tool, ToolContext, ToolExecutionResult } from '../toolRegistry';
import {
  getAllBackgroundTasks,
  getTaskOutput,
  killBackgroundTask,
  isTaskId,
} from './backgroundTasks';
import {
  getAllPtySessions,
  getPtySessionOutput,
  getPtySessionLog,
  pollPtySession,
  writeToPtySession,
  submitToPtySession,
  killPtySession,
  isPtySessionId,
} from './ptyExecutor';

// ============================================================================
// Process List Tool
// ============================================================================

export const processListTool: Tool = {
  name: 'process_list',
  description: `List all running and completed background processes and PTY sessions.

Returns information about:
- Background tasks (started with run_in_background=true)
- PTY sessions (started with pty=true)

Each entry includes:
- session_id/task_id: Unique identifier
- type: 'background' or 'pty'
- status: 'running', 'completed', or 'failed'
- command: The command being executed
- start_time: When the process started
- duration: How long it has been running
- exit_code: Exit code if completed`,

  generations: ['gen1', 'gen2', 'gen3', 'gen4', 'gen5', 'gen6', 'gen7', 'gen8'],
  requiresPermission: false,
  permissionLevel: 'read',

  inputSchema: {
    type: 'object',
    properties: {
      filter: {
        type: 'string',
        enum: ['all', 'running', 'completed', 'failed', 'pty', 'background'],
        description: 'Filter processes by status or type (default: all)',
      },
    },
  },

  async execute(params: Record<string, unknown>): Promise<ToolExecutionResult> {
    const filter = (params.filter as string) || 'all';

    const backgroundTasks = getAllBackgroundTasks();
    const ptySessions = getAllPtySessions();

    const allProcesses = [
      ...backgroundTasks.map((t) => ({
        id: t.taskId,
        type: 'background' as const,
        status: t.status,
        command: t.command,
        startTime: t.startTime,
        endTime: t.endTime,
        duration: t.duration,
        exitCode: t.exitCode,
        outputFile: t.outputFile,
      })),
      ...ptySessions.map((s) => ({
        id: s.sessionId,
        type: 'pty' as const,
        status: s.status,
        command: `${s.command} ${s.args.join(' ')}`.trim(),
        startTime: s.startTime,
        endTime: s.endTime,
        duration: s.duration,
        exitCode: s.exitCode,
        outputFile: s.outputFile,
        cols: s.cols,
        rows: s.rows,
      })),
    ];

    // Apply filter
    const filtered = allProcesses.filter((p) => {
      if (filter === 'all') return true;
      if (filter === 'running') return p.status === 'running';
      if (filter === 'completed') return p.status === 'completed';
      if (filter === 'failed') return p.status === 'failed';
      if (filter === 'pty') return p.type === 'pty';
      if (filter === 'background') return p.type === 'background';
      return true;
    });

    if (filtered.length === 0) {
      return {
        success: true,
        output: `No processes found${filter !== 'all' ? ` matching filter: ${filter}` : ''}.`,
      };
    }

    const formatDuration = (ms: number): string => {
      if (ms < 1000) return `${ms}ms`;
      if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
      return `${(ms / 60000).toFixed(1)}m`;
    };

    const lines = filtered.map((p) => {
      const status = p.status === 'running' ? '🟢' : p.status === 'completed' ? '✅' : '❌';
      const exitInfo = p.exitCode !== undefined ? ` (exit: ${p.exitCode})` : '';
      const termSize = 'cols' in p ? ` [${p.cols}x${p.rows}]` : '';
      return `${status} [${p.type}] ${p.id.substring(0, 8)}... | ${formatDuration(p.duration)} | ${p.command.substring(0, 40)}${p.command.length > 40 ? '...' : ''}${exitInfo}${termSize}`;
    });

    const output = `Found ${filtered.length} process(es):

${lines.join('\n')}

Use process_poll <id> to get new output.
Use process_log <id> to get full log.
Use process_kill <id> to terminate a running process.`;

    return {
      success: true,
      output,
    };
  },
};

// ============================================================================
// Process Poll Tool
// ============================================================================

export const processPollTool: Tool = {
  name: 'process_poll',
  description: `Poll a background process or PTY session for new output since the last poll.

This is useful for checking on running processes without blocking.
Returns only the NEW output since the last time this process was polled.

For PTY sessions, this is the preferred way to check for interactive command output.`,

  generations: ['gen1', 'gen2', 'gen3', 'gen4', 'gen5', 'gen6', 'gen7', 'gen8'],
  requiresPermission: false,
  permissionLevel: 'read',

  inputSchema: {
    type: 'object',
    properties: {
      session_id: {
        type: 'string',
        description: 'The session/task ID to poll',
      },
      block: {
        type: 'boolean',
        description: 'If true, wait for process to complete (default: false)',
      },
      timeout: {
        type: 'number',
        description: 'Timeout in milliseconds when blocking (default: 30000)',
      },
    },
    required: ['session_id'],
  },

  async execute(params: Record<string, unknown>): Promise<ToolExecutionResult> {
    const sessionId = params.session_id as string;
    const block = params.block as boolean;
    const timeout = (params.timeout as number) || 30000;

    // Check if it's a PTY session
    if (isPtySessionId(sessionId)) {
      if (block) {
        const output = await getPtySessionOutput(sessionId, true, timeout);
        if (!output) {
          return { success: false, error: `PTY session not found: ${sessionId}` };
        }

        return {
          success: true,
          output: `Status: ${output.status}
Exit Code: ${output.exitCode ?? 'N/A'}
Duration: ${output.duration}ms

Output:
${output.output}`,
        };
      }

      const result = pollPtySession(sessionId);
      if (!result.success) {
        return { success: false, error: result.error };
      }

      const hasNewData = result.data && result.data.length > 0;
      return {
        success: true,
        output: `Status: ${result.status}
Exit Code: ${result.exitCode ?? 'N/A'}
New Output: ${hasNewData ? 'Yes' : 'No'}

${hasNewData ? result.data : '(no new output)'}`,
      };
    }

    // Check if it's a background task
    if (isTaskId(sessionId)) {
      const output = await getTaskOutput(sessionId, block, timeout);
      if (!output) {
        return { success: false, error: `Task not found: ${sessionId}` };
      }

      return {
        success: true,
        output: `Status: ${output.status}
Exit Code: ${output.exitCode ?? 'N/A'}
Duration: ${output.duration}ms

Output:
${output.output}`,
      };
    }

    return { success: false, error: `No process found with ID: ${sessionId}` };
  },
};

// ============================================================================
// Process Log Tool
// ============================================================================

export const processLogTool: Tool = {
  name: 'process_log',
  description: `Get the full log output from a process or PTY session.

Reads the log file directly, which may contain more output than what's in memory.
Useful for reviewing the complete history of a long-running process.`,

  generations: ['gen1', 'gen2', 'gen3', 'gen4', 'gen5', 'gen6', 'gen7', 'gen8'],
  requiresPermission: false,
  permissionLevel: 'read',

  inputSchema: {
    type: 'object',
    properties: {
      session_id: {
        type: 'string',
        description: 'The session/task ID to get log for',
      },
      tail: {
        type: 'number',
        description: 'Only return the last N lines (default: all)',
      },
    },
    required: ['session_id'],
  },

  async execute(params: Record<string, unknown>): Promise<ToolExecutionResult> {
    const sessionId = params.session_id as string;
    const tail = params.tail as number | undefined;

    // Try PTY session first
    const ptyResult = getPtySessionLog(sessionId, tail);
    if (ptyResult.success) {
      return {
        success: true,
        output: `Log for PTY session ${sessionId}:

${ptyResult.log}`,
      };
    }

    // Try background task
    const taskOutput = await getTaskOutput(sessionId, false);
    if (taskOutput) {
      let log = taskOutput.output;
      if (tail && tail > 0) {
        const lines = log.split('\n');
        log = lines.slice(-tail).join('\n');
      }

      return {
        success: true,
        output: `Log for background task ${sessionId}:
Status: ${taskOutput.status}
Exit Code: ${taskOutput.exitCode ?? 'N/A'}

${log}`,
      };
    }

    return { success: false, error: `No process found with ID: ${sessionId}` };
  },
};

// ============================================================================
// Process Write Tool
// ============================================================================

export const processWriteTool: Tool = {
  name: 'process_write',
  description: `Write raw input to a PTY session.

Sends the exact input string to the terminal without adding a newline.
Use this for sending control characters, escape sequences, or partial input.

For sending complete commands, use process_submit instead which adds a newline.`,

  generations: ['gen1', 'gen2', 'gen3', 'gen4', 'gen5', 'gen6', 'gen7', 'gen8'],
  requiresPermission: true,
  permissionLevel: 'execute',

  inputSchema: {
    type: 'object',
    properties: {
      session_id: {
        type: 'string',
        description: 'The PTY session ID to write to',
      },
      data: {
        type: 'string',
        description: 'The data to write (can include escape sequences like \\x1b, \\n, etc.)',
      },
    },
    required: ['session_id', 'data'],
  },

  async execute(params: Record<string, unknown>): Promise<ToolExecutionResult> {
    const sessionId = params.session_id as string;
    const data = params.data as string;

    if (!isPtySessionId(sessionId)) {
      return {
        success: false,
        error: `Not a PTY session: ${sessionId}. Use this tool only with PTY sessions.`,
      };
    }

    // Process escape sequences in the data
    const processedData = data
      .replace(/\\x([0-9a-fA-F]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
      .replace(/\\n/g, '\n')
      .replace(/\\r/g, '\r')
      .replace(/\\t/g, '\t')
      .replace(/\\e/g, '\x1b')
      .replace(/\\033/g, '\x1b');

    const result = writeToPtySession(sessionId, processedData);
    if (!result.success) {
      return { success: false, error: result.error };
    }

    return {
      success: true,
      output: `Wrote ${processedData.length} bytes to PTY session ${sessionId}.`,
    };
  },
};

// ============================================================================
// Process Submit Tool
// ============================================================================

export const processSubmitTool: Tool = {
  name: 'process_submit',
  description: `Submit a command or input to a PTY session (adds newline automatically).

This is the standard way to send commands to an interactive PTY session.
Equivalent to typing the input and pressing Enter.`,

  generations: ['gen1', 'gen2', 'gen3', 'gen4', 'gen5', 'gen6', 'gen7', 'gen8'],
  requiresPermission: true,
  permissionLevel: 'execute',

  inputSchema: {
    type: 'object',
    properties: {
      session_id: {
        type: 'string',
        description: 'The PTY session ID to submit to',
      },
      input: {
        type: 'string',
        description: 'The input/command to submit (newline added automatically)',
      },
    },
    required: ['session_id', 'input'],
  },

  async execute(params: Record<string, unknown>): Promise<ToolExecutionResult> {
    const sessionId = params.session_id as string;
    const input = params.input as string;

    if (!isPtySessionId(sessionId)) {
      return {
        success: false,
        error: `Not a PTY session: ${sessionId}. Use this tool only with PTY sessions.`,
      };
    }

    const result = submitToPtySession(sessionId, input);
    if (!result.success) {
      return { success: false, error: result.error };
    }

    return {
      success: true,
      output: `Submitted input to PTY session ${sessionId}: "${input.substring(0, 50)}${input.length > 50 ? '...' : ''}"`,
    };
  },
};

// ============================================================================
// Process Kill Tool
// ============================================================================

export const processKillTool: Tool = {
  name: 'process_kill',
  description: `Terminate a running background process or PTY session.

Sends SIGTERM (and SIGKILL if needed) to stop the process.
Works for both background tasks and PTY sessions.`,

  generations: ['gen1', 'gen2', 'gen3', 'gen4', 'gen5', 'gen6', 'gen7', 'gen8'],
  requiresPermission: true,
  permissionLevel: 'execute',

  inputSchema: {
    type: 'object',
    properties: {
      session_id: {
        type: 'string',
        description: 'The session/task ID to terminate',
      },
    },
    required: ['session_id'],
  },

  async execute(params: Record<string, unknown>): Promise<ToolExecutionResult> {
    const sessionId = params.session_id as string;

    // Try PTY session first
    if (isPtySessionId(sessionId)) {
      const result = killPtySession(sessionId);
      if (!result.success) {
        return { success: false, error: result.error };
      }
      return { success: true, output: result.message };
    }

    // Try background task
    if (isTaskId(sessionId)) {
      const result = killBackgroundTask(sessionId);
      if (!result.success) {
        return { success: false, error: result.error };
      }
      return { success: true, output: result.message };
    }

    return { success: false, error: `No process found with ID: ${sessionId}` };
  },
};
