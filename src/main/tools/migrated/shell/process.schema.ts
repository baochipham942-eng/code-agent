// Schema-only file (P0-7 方案 A — single source of truth)
import type { ToolSchema } from '../../../protocol/tools';

export const processSchema: ToolSchema = {
  name: 'Process',
  description: `Manages system processes: list running, poll output, get logs, write to PTY sessions, submit commands, kill processes, or get task output.

Actions:
- list: list all background tasks and PTY sessions (filter: all|running|completed|failed|pty|background)
- poll: poll a process for new output (session_id, optional block/timeout)
- log: get full log from a process (session_id, optional tail)
- write: write raw bytes to a PTY session (session_id, data)
- submit: submit a command line to a PTY session, adds newline (session_id, input)
- kill: terminate a process or PTY session (session_id or task_id)
- output: get output from a background task (task_id, optional block/timeout)`,
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['list', 'poll', 'log', 'write', 'submit', 'kill', 'output'],
      },
      filter: {
        type: 'string',
        enum: ['all', 'running', 'completed', 'failed', 'pty', 'background'],
      },
      session_id: { type: 'string' },
      task_id: { type: 'string' },
      block: { type: 'boolean' },
      timeout: { type: 'number' },
      tail: { type: 'number' },
      data: { type: 'string' },
      input: { type: 'string' },
    },
    required: ['action'],
  },
  category: 'shell',
  permissionLevel: 'execute',
  readOnly: false,
  allowInPlanMode: false,
};
