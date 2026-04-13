// ============================================================================
// Process (P0-5 Migrated to ToolModule)
//
// 旧版: src/main/tools/shell/ProcessTool.ts (registered as 'Process')
//      + src/main/tools/shell/process.ts (6 个 process_* sub tools)
//
// 整合方案：单个 'Process' 模块内部 switch(action) 调 backgroundTasks /
// ptyExecutor helper。原来 7 个 sub tools 的逻辑被合并到一个 ToolHandler。
//
// LLM 看到的接口和 legacy 相同（action: list/poll/log/write/submit/kill/output）。
// 子工具 process_list/process_poll/... 仍在 legacy registry 注册，独立调用兼容。
// ============================================================================

import type {
  ToolHandler,
  ToolModule,
  ToolContext,
  CanUseToolFn,
  ToolProgressFn,
  ToolResult,
} from '../../../protocol/tools';
import { processSchema as schema } from './process.schema';
import {
  getAllBackgroundTasks,
  getTaskOutput,
  killBackgroundTask,
  isTaskId,
} from '../../shell/backgroundTasks';
import { formatDuration } from '../../../../shared/utils/format';
import {
  getAllPtySessions,
  getPtySessionOutput,
  getPtySessionLog,
  pollPtySession,
  writeToPtySession,
  submitToPtySession,
  killPtySession,
  isPtySessionId,
} from '../../shell/ptyExecutor';

const DEFAULT_POLL_TIMEOUT = 30000;

// ----------------------------------------------------------------------------
// Action handlers — 每个 action 对应 legacy sub tool 的 execute 逻辑
// ----------------------------------------------------------------------------

function handleList(args: Record<string, unknown>): ToolResult<string> {
  const filter = (args.filter as string | undefined) ?? 'all';
  const backgroundTasks = getAllBackgroundTasks();
  const ptySessions = getAllPtySessions();

  const allProcesses = [
    ...backgroundTasks.map((t) => ({
      id: t.taskId,
      type: 'background' as const,
      status: t.status,
      command: t.command,
      duration: t.duration,
      exitCode: t.exitCode,
    })),
    ...ptySessions.map((s) => ({
      id: s.sessionId,
      type: 'pty' as const,
      status: s.status,
      command: `${s.command} ${s.args.join(' ')}`.trim(),
      duration: s.duration,
      exitCode: s.exitCode,
      cols: s.cols,
      rows: s.rows,
    })),
  ];

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
      ok: true,
      output: `No processes found${filter !== 'all' ? ` matching filter: ${filter}` : ''}.`,
    };
  }

  const lines = filtered.map((p) => {
    const status = p.status === 'running' ? '🟢' : p.status === 'completed' ? '✅' : '❌';
    const exitInfo = p.exitCode !== undefined ? ` (exit: ${p.exitCode})` : '';
    const termSize = 'cols' in p ? ` [${p.cols}x${p.rows}]` : '';
    return `${status} [${p.type}] ${p.id.substring(0, 8)}... | ${formatDuration(p.duration)} | ${p.command.substring(0, 40)}${p.command.length > 40 ? '...' : ''}${exitInfo}${termSize}`;
  });

  const output = `Found ${filtered.length} process(es):

${lines.join('\n')}

Use Process action=poll <id> to get new output.
Use Process action=log <id> to get full log.
Use Process action=kill <id> to terminate a running process.`;

  return { ok: true, output };
}

async function handlePoll(args: Record<string, unknown>): Promise<ToolResult<string>> {
  const sessionId = args.session_id as string | undefined;
  const block = Boolean(args.block);
  const timeout = (args.timeout as number | undefined) ?? DEFAULT_POLL_TIMEOUT;

  if (!sessionId) {
    return { ok: false, error: 'session_id is required for poll action', code: 'INVALID_ARGS' };
  }

  if (isPtySessionId(sessionId)) {
    if (block) {
      const output = await getPtySessionOutput(sessionId, true, timeout);
      if (!output) {
        return { ok: false, error: `PTY session not found: ${sessionId}`, code: 'NOT_FOUND' };
      }
      return {
        ok: true,
        output: `Status: ${output.status}\nExit Code: ${output.exitCode ?? 'N/A'}\nDuration: ${output.duration}ms\n\nOutput:\n${output.output}`,
      };
    }
    const result = pollPtySession(sessionId);
    if (!result.success) {
      return { ok: false, error: result.error ?? 'poll failed', code: 'POLL_FAILED' };
    }
    const hasNewData = result.data && result.data.length > 0;
    return {
      ok: true,
      output: `Status: ${result.status}\nExit Code: ${result.exitCode ?? 'N/A'}\nNew Output: ${hasNewData ? 'Yes' : 'No'}\n\n${hasNewData ? result.data : '(no new output)'}`,
    };
  }

  if (isTaskId(sessionId)) {
    const output = await getTaskOutput(sessionId, block, timeout);
    if (!output) {
      return { ok: false, error: `Task not found: ${sessionId}`, code: 'NOT_FOUND' };
    }
    return {
      ok: true,
      output: `Status: ${output.status}\nExit Code: ${output.exitCode ?? 'N/A'}\nDuration: ${output.duration}ms\n\nOutput:\n${output.output}`,
    };
  }

  return { ok: false, error: `No process found with ID: ${sessionId}`, code: 'NOT_FOUND' };
}

async function handleLog(args: Record<string, unknown>): Promise<ToolResult<string>> {
  const sessionId = args.session_id as string | undefined;
  const tail = args.tail as number | undefined;

  if (!sessionId) {
    return { ok: false, error: 'session_id is required for log action', code: 'INVALID_ARGS' };
  }

  // Try PTY session first
  const ptyResult = getPtySessionLog(sessionId, tail);
  if (ptyResult.success) {
    return { ok: true, output: `Log for PTY session ${sessionId}:\n\n${ptyResult.log}` };
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
      ok: true,
      output: `Log for background task ${sessionId}:\nStatus: ${taskOutput.status}\nExit Code: ${taskOutput.exitCode ?? 'N/A'}\n\n${log}`,
    };
  }

  return { ok: false, error: `No process found with ID: ${sessionId}`, code: 'NOT_FOUND' };
}

function handleWrite(args: Record<string, unknown>): ToolResult<string> {
  const sessionId = args.session_id as string | undefined;
  const data = args.data as string | undefined;

  if (!sessionId || typeof data !== 'string') {
    return { ok: false, error: 'session_id and data are required for write action', code: 'INVALID_ARGS' };
  }

  if (!isPtySessionId(sessionId)) {
    return {
      ok: false,
      error: `Not a PTY session: ${sessionId}. Use this action only with PTY sessions.`,
      code: 'INVALID_SESSION',
    };
  }

  // Process escape sequences
  const processedData = data
    .replace(/\\x([0-9a-fA-F]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\r')
    .replace(/\\t/g, '\t')
    .replace(/\\e/g, '\x1b')
    .replace(/\\033/g, '\x1b');

  const result = writeToPtySession(sessionId, processedData);
  if (!result.success) {
    return { ok: false, error: result.error ?? 'write failed', code: 'WRITE_FAILED' };
  }

  return { ok: true, output: `Wrote ${processedData.length} bytes to PTY session ${sessionId}.` };
}

function handleSubmit(args: Record<string, unknown>): ToolResult<string> {
  const sessionId = args.session_id as string | undefined;
  const input = args.input as string | undefined;

  if (!sessionId || typeof input !== 'string') {
    return { ok: false, error: 'session_id and input are required for submit action', code: 'INVALID_ARGS' };
  }

  if (!isPtySessionId(sessionId)) {
    return {
      ok: false,
      error: `Not a PTY session: ${sessionId}. Use this action only with PTY sessions.`,
      code: 'INVALID_SESSION',
    };
  }

  const result = submitToPtySession(sessionId, input);
  if (!result.success) {
    return { ok: false, error: result.error ?? 'submit failed', code: 'SUBMIT_FAILED' };
  }

  return {
    ok: true,
    output: `Submitted input to PTY session ${sessionId}: "${input.substring(0, 50)}${input.length > 50 ? '...' : ''}"`,
  };
}

function handleKill(args: Record<string, unknown>): ToolResult<string> {
  // 兼容 session_id 和 task_id 两个参数名
  const id = (args.session_id as string | undefined) ?? (args.task_id as string | undefined);
  if (!id) {
    return { ok: false, error: 'session_id or task_id is required for kill action', code: 'INVALID_ARGS' };
  }

  // Try PTY session first
  if (isPtySessionId(id)) {
    const result = killPtySession(id);
    if (!result.success) {
      return { ok: false, error: result.error ?? 'kill pty failed', code: 'KILL_FAILED' };
    }
    return { ok: true, output: result.message ?? `Killed PTY session: ${id}` };
  }

  if (isTaskId(id)) {
    const result = killBackgroundTask(id);
    if (!result.success) {
      return { ok: false, error: result.error ?? 'kill task failed', code: 'KILL_FAILED' };
    }
    return { ok: true, output: result.message ?? `Killed task: ${id}` };
  }

  return { ok: false, error: `No process found with ID: ${id}`, code: 'NOT_FOUND' };
}

async function handleOutput(args: Record<string, unknown>): Promise<ToolResult<string>> {
  // Output 兼容 task_id 和 session_id（legacy task_output 用 task_id）
  const id = (args.task_id as string | undefined) ?? (args.session_id as string | undefined);
  const block = args.block !== false; // default true
  const timeout = (args.timeout as number | undefined) ?? DEFAULT_POLL_TIMEOUT;

  if (!id) {
    // No id → list all tasks（沿用 task_output 的 list 行为）
    const tasks = getAllBackgroundTasks();
    if (tasks.length === 0) {
      return { ok: true, output: 'No background tasks found.' };
    }
    const lines = [`Found ${tasks.length} background task(s):\n`];
    for (const task of tasks) {
      const durationSec = (task.duration / 1000).toFixed(1);
      const statusIcon =
        task.status === 'running' ? '🔄' : task.status === 'completed' ? '✅' : '❌';
      lines.push(`${statusIcon} Task: ${task.taskId}`);
      lines.push(`   Command: ${task.command.substring(0, 60)}${task.command.length > 60 ? '...' : ''}`);
      lines.push(`   Status: ${task.status}`);
      lines.push(`   Duration: ${durationSec}s`);
      if (task.exitCode !== undefined) {
        lines.push(`   Exit code: ${task.exitCode}`);
      }
      lines.push('');
    }
    return { ok: true, output: lines.join('\n') };
  }

  if (!isTaskId(id)) {
    return { ok: false, error: `Task ${id} not found.`, code: 'NOT_FOUND' };
  }

  const result = await getTaskOutput(id, block, timeout);
  if (!result) {
    return { ok: false, error: `Failed to get output for task: ${id}`, code: 'OUTPUT_FAILED' };
  }

  const durationSec = (result.duration / 1000).toFixed(2);
  const lines: string[] = [
    `=== Task ${id} ===`,
    `Status: ${result.status}`,
    `Duration: ${durationSec}s`,
  ];
  if (result.exitCode !== undefined) {
    lines.push(`Exit code: ${result.exitCode}`);
  }
  lines.push('');
  lines.push('--- Output ---');
  lines.push(result.output || '(no output)');

  return {
    ok: true,
    output: lines.join('\n'),
    meta: { taskId: id, status: result.status, exitCode: result.exitCode, duration: result.duration },
  };
}

// ----------------------------------------------------------------------------
// Handler
// ----------------------------------------------------------------------------

class ProcessHandler implements ToolHandler<Record<string, unknown>, string> {
  readonly schema = schema;

  async execute(
    args: Record<string, unknown>,
    ctx: ToolContext,
    canUseTool: CanUseToolFn,
    onProgress?: ToolProgressFn,
  ): Promise<ToolResult<string>> {
    const action = args.action as string | undefined;

    if (!action) {
      return { ok: false, error: 'action is required', code: 'INVALID_ARGS' };
    }

    const permit = await canUseTool(schema.name, args);
    if (!permit.allow) {
      return { ok: false, error: `permission denied: ${permit.reason}`, code: 'PERMISSION_DENIED' };
    }
    if (ctx.abortSignal.aborted) {
      return { ok: false, error: 'aborted', code: 'ABORTED' };
    }

    onProgress?.({ stage: 'starting', detail: `Process ${action}` });

    let result: ToolResult<string>;
    try {
      switch (action) {
        case 'list':
          result = handleList(args);
          break;
        case 'poll':
          result = await handlePoll(args);
          break;
        case 'log':
          result = await handleLog(args);
          break;
        case 'write':
          result = handleWrite(args);
          break;
        case 'submit':
          result = handleSubmit(args);
          break;
        case 'kill':
          result = handleKill(args);
          break;
        case 'output':
          result = await handleOutput(args);
          break;
        default:
          return {
            ok: false,
            error: `Unknown action: ${action}. Valid actions: list, poll, log, write, submit, kill, output`,
            code: 'INVALID_ACTION',
          };
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      ctx.logger.warn('Process action threw', { action, err: msg });
      return { ok: false, error: msg, code: 'ACTION_THREW' };
    }

    onProgress?.({ stage: 'completing', percent: 100 });
    if (result.ok) {
      ctx.logger.info('Process done', { action });
    } else {
      ctx.logger.debug('Process action failed', { action, error: result.error });
    }
    return result;
  }
}

export const processModule: ToolModule<Record<string, unknown>, string> = {
  schema,
  createHandler() {
    return new ProcessHandler();
  },
};
