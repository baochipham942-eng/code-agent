// ============================================================================
// KillShell (P0-5 Migrated to ToolModule)
//
// 旧版: src/main/tools/shell/killShell.ts (registered as 'kill_shell')
// 改造点：4 参数签名 + canUseTool 真权限闸门 + ctx.logger
// 业务依赖（backgroundTasks）保留——它是 sibling tool 模块
// ============================================================================

import type {
  ToolHandler,
  ToolModule,
  ToolContext,
  CanUseToolFn,
  ToolProgressFn,
  ToolResult,
} from '../../../protocol/tools';
import { killShellSchema as schema } from './killShell.schema';
import {
  killBackgroundTask,
  isTaskId,
  getAllBackgroundTasks,
} from '../../shell/backgroundTasks';

class KillShellHandler implements ToolHandler<Record<string, unknown>, string> {
  readonly schema = schema;

  async execute(
    args: Record<string, unknown>,
    ctx: ToolContext,
    canUseTool: CanUseToolFn,
    onProgress?: ToolProgressFn,
  ): Promise<ToolResult<string>> {
    const taskId = args.task_id as string | undefined;

    if (!taskId) {
      return { ok: false, error: 'task_id is required', code: 'INVALID_ARGS' };
    }

    const permit = await canUseTool(schema.name, args);
    if (!permit.allow) {
      return { ok: false, error: `permission denied: ${permit.reason}`, code: 'PERMISSION_DENIED' };
    }
    if (ctx.abortSignal.aborted) {
      return { ok: false, error: 'aborted', code: 'ABORTED' };
    }

    onProgress?.({ stage: 'starting', detail: `kill ${taskId}` });

    if (!isTaskId(taskId)) {
      const tasks = getAllBackgroundTasks();
      const runningTasks = tasks.filter((t) => t.status === 'running');

      if (runningTasks.length === 0) {
        return {
          ok: false,
          error: `No task found with ID: ${taskId}. There are no running background tasks.`,
          code: 'NOT_FOUND',
        };
      }

      const taskList = runningTasks
        .map(
          (t) =>
            `  - ${t.taskId}: ${t.command.substring(0, 50)}${t.command.length > 50 ? '...' : ''}`,
        )
        .join('\n');

      return {
        ok: false,
        error: `No task found with ID: ${taskId}.\n\nRunning tasks:\n${taskList}`,
        code: 'NOT_FOUND',
      };
    }

    const result = killBackgroundTask(taskId);

    onProgress?.({ stage: 'completing', percent: 100 });

    if (result.success) {
      ctx.logger.info('kill_shell done', { taskId });
      return { ok: true, output: result.message || `Successfully killed task: ${taskId}` };
    } else {
      ctx.logger.warn('kill_shell failed', { taskId, error: result.error });
      return { ok: false, error: result.error || 'Failed to kill task', code: 'KILL_FAILED' };
    }
  }
}

export const killShellModule: ToolModule<Record<string, unknown>, string> = {
  schema,
  createHandler() {
    return new KillShellHandler();
  },
};
