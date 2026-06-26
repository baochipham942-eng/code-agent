// ============================================================================
// TaskOutput (P0-5 Migrated to ToolModule)
//
// 旧版: src/host/tools/shell/taskOutput.ts (registered as 'task_output')
// 改造点：4 参数签名 + canUseTool + ctx.logger
// ============================================================================

import type {
  ToolHandler,
  ToolModule,
  ToolContext,
  CanUseToolFn,
  ToolProgressFn,
  ToolResult,
} from '../../../protocol/tools';
import { createFileArtifact, createVirtualArtifact } from '../../artifacts/artifactMeta';
import { taskOutputSchema as schema } from './taskOutput.schema';
import {
  getTaskOutput,
  getAllBackgroundTasks,
  isTaskId,
  getBackgroundTask,
} from '../../shell/backgroundTasks';

const DEFAULT_TIMEOUT = 30000;

class TaskOutputHandler implements ToolHandler<Record<string, unknown>, string> {
  readonly schema = schema;

  async execute(
    args: Record<string, unknown>,
    ctx: ToolContext,
    canUseTool: CanUseToolFn,
    onProgress?: ToolProgressFn,
  ): Promise<ToolResult<string>> {
    const taskId = args.task_id as string | undefined;
    const block = args.block !== false; // default true
    const timeout = (args.timeout as number | undefined) ?? DEFAULT_TIMEOUT;

    const permit = await canUseTool(schema.name, args);
    if (!permit.allow) {
      return { ok: false, error: `permission denied: ${permit.reason}`, code: 'PERMISSION_DENIED' };
    }
    if (ctx.abortSignal.aborted) {
      return { ok: false, error: 'aborted', code: 'ABORTED' };
    }

    onProgress?.({ stage: 'starting', detail: taskId ? `output ${taskId}` : 'list tasks' });

    // No task_id → list all tasks
    if (!taskId) {
      const tasks = getAllBackgroundTasks();

      if (tasks.length === 0) {
        const output = 'No background tasks found.';
        return {
          ok: true,
          output,
          meta: {
            tasks: [],
            taskCount: 0,
            artifact: createVirtualArtifact({
              sourceTool: schema.name,
              kind: 'process-output',
              sessionId: ctx.sessionId,
              name: 'Background tasks',
              mimeType: 'text/plain',
              contentLength: output.length,
              preview: output,
              metadata: { taskCount: 0 },
            }),
          },
        };
      }

      const lines = [`Found ${tasks.length} background task(s):\n`];
      for (const task of tasks) {
        const durationSec = (task.duration / 1000).toFixed(1);
        const statusIcon =
          task.status === 'running' ? '🔄' : task.status === 'completed' ? '✅' : '❌';
        lines.push(`${statusIcon} Task: ${task.taskId}`);
        lines.push(
          `   Command: ${task.command.substring(0, 60)}${task.command.length > 60 ? '...' : ''}`,
        );
        lines.push(`   Status: ${task.status}`);
        lines.push(`   Duration: ${durationSec}s`);
        if (task.exitCode !== undefined) {
          lines.push(`   Exit code: ${task.exitCode}`);
        }
        lines.push(`   Output file: ${task.outputFile}`);
        lines.push('');
      }
      const output = lines.join('\n');
      return {
        ok: true,
        output,
        meta: {
          taskCount: tasks.length,
          tasks,
          artifact: createVirtualArtifact({
            sourceTool: schema.name,
            kind: 'process-output',
            sessionId: ctx.sessionId,
            name: 'Background tasks',
            mimeType: 'text/plain',
            contentLength: output.length,
            preview: output.slice(0, 500),
            metadata: {
              taskCount: tasks.length,
              runningCount: tasks.filter(task => task.status === 'running').length,
            },
          }),
        },
      };
    }

    // Check task exists
    if (!isTaskId(taskId)) {
      const tasks = getAllBackgroundTasks();
      if (tasks.length === 0) {
        return {
          ok: false,
          error: `Task ${taskId} not found. There are no background tasks.`,
          code: 'NOT_FOUND',
        };
      }
      const taskList = tasks.map((t) => `  - ${t.taskId} (${t.status})`).join('\n');
      return {
        ok: false,
        error: `Task ${taskId} not found.\n\nAvailable tasks:\n${taskList}`,
        code: 'NOT_FOUND',
      };
    }

    // Get task output (blocking or non-blocking)
    const result = await getTaskOutput(taskId, block, timeout);
    if (!result) {
      return { ok: false, error: `Failed to get output for task: ${taskId}`, code: 'OUTPUT_FAILED' };
    }

    const task = getBackgroundTask(taskId);
    const durationSec = (result.duration / 1000).toFixed(2);

    const lines: string[] = [];
    lines.push(`=== Task ${taskId} ===`);
    lines.push(`Status: ${result.status}`);
    lines.push(`Duration: ${durationSec}s`);
    if (result.exitCode !== undefined) {
      lines.push(`Exit code: ${result.exitCode}`);
    }
    if (task) {
      lines.push(`Command: ${task.command}`);
      lines.push(`Output file: ${task.outputFile}`);
    }
    lines.push('');
    lines.push('--- Output ---');
    lines.push(result.output || '(no output)');

    onProgress?.({ stage: 'completing', percent: 100 });
    ctx.logger.info('task_output done', { taskId, status: result.status });

    return {
      ok: true,
      output: lines.join('\n'),
      meta: {
        artifact: task?.outputFile
          ? await createFileArtifact(task.outputFile, schema.name, ctx, {
            kind: 'process-log',
            mimeType: 'text/plain',
            metadata: {
              taskId,
              status: result.status,
              exitCode: result.exitCode,
              duration: result.duration,
              command: task.command,
            },
          }).catch(() => undefined)
          : createVirtualArtifact({
            sourceTool: schema.name,
            kind: 'process-output',
            sessionId: ctx.sessionId,
            name: `Task output: ${taskId}`,
            mimeType: 'text/plain',
            contentLength: lines.join('\n').length,
            preview: lines.join('\n').slice(0, 500),
            metadata: {
              taskId,
              status: result.status,
              exitCode: result.exitCode,
              duration: result.duration,
            },
          }),
        taskId,
        status: result.status,
        exitCode: result.exitCode,
        duration: result.duration,
        outputFile: task?.outputFile,
      },
    };
  }
}

export const taskOutputModule: ToolModule<Record<string, unknown>, string> = {
  schema,
  createHandler() {
    return new TaskOutputHandler();
  },
};
