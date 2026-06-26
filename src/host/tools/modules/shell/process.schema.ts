// Schema-only file (P0-7 方案 A — single source of truth)
import type { ToolSchema } from '../../../protocol/tools';

export const processSchema: ToolSchema = {
  name: 'Process',
  description: `Manages system processes: list running, poll output, get logs, write to PTY sessions, submit commands, kill processes, or get task output.

Actions:
- list: observe all background tasks and PTY sessions (filter: all|running|completed|failed|pty|background)
- poll: observe new process output (session_id, optional block/timeout)
- log: observe full log from a process (session_id, optional tail)
- output: observe output from a background task (task_id, optional block/timeout)
- write: control a PTY session by writing raw bytes (session_id, data)
- submit: control a PTY session by submitting a command line, adds newline (session_id, input)
- kill: control a process or PTY session by terminating it (session_id or task_id)

Permission split: list/poll/log/output are observation actions; write/submit/kill are control actions.`,
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['list', 'poll', 'log', 'write', 'submit', 'kill', 'output'],
        description: 'Observation actions: list, poll, log, output. Control actions: write, submit, kill.',
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
