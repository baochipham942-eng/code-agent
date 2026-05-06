// ============================================================================
// TaskGet (P1 Wave 3 — planning: native ToolModule rewrite)
//
// 旧版: src/main/tools/planning/taskGet.ts
// 改造点：
// - 4 参数签名 (args, ctx, canUseTool, onProgress)
// - 五链 + 错误码：INVALID_ARGS / PERMISSION_DENIED / ABORTED / NOT_FOUND
// - 行为保真：blockedBy / blocks / metadata 输出 1:1
// ============================================================================

import type {
  ToolHandler,
  ToolModule,
  ToolContext,
  CanUseToolFn,
  ToolProgressFn,
  ToolResult,
} from '../../../protocol/tools';
import { getTask, listTasks } from '../../../services/planning/taskStore';
import { taskGetSchema as schema } from './taskGet.schema';

export async function executeTaskGet(
  args: Record<string, unknown>,
  ctx: ToolContext,
  canUseTool: CanUseToolFn,
  onProgress?: ToolProgressFn,
): Promise<ToolResult<string>> {
  const taskId = args.taskId;
  if (typeof taskId !== 'string' || !taskId) {
    return {
      ok: false,
      error: 'taskId is required and must be a string',
      code: 'INVALID_ARGS',
    };
  }

  const permit = await canUseTool(schema.name, args);
  if (!permit.allow) {
    return { ok: false, error: `permission denied: ${permit.reason}`, code: 'PERMISSION_DENIED' };
  }
  if (ctx.abortSignal.aborted) {
    return { ok: false, error: 'aborted', code: 'ABORTED' };
  }

  onProgress?.({ stage: 'starting', detail: schema.name });

  const sessionId = ctx.sessionId || 'default';
  const task = getTask(sessionId, taskId);

  if (!task) {
    const allTasks = listTasks(sessionId);
    const availableIds = allTasks.map((t) => t.id).join(', ') || 'none';
    return {
      ok: false,
      error: `Task #${taskId} not found. Available task IDs: ${availableIds}`,
      code: 'NOT_FOUND',
    };
  }

  const allTasks = listTasks(sessionId);
  const openBlockers = task.blockedBy.filter((id) => {
    const blocker = allTasks.find((t) => t.id === id);
    return blocker && blocker.status !== 'completed';
  });

  const blockedByInfo =
    task.blockedBy.length > 0
      ? `  Blocked By: ${task.blockedBy.join(', ')}${
          openBlockers.length > 0 ? ` (${openBlockers.length} open)` : ' (all resolved)'
        }`
      : '';

  const blocksInfo = task.blocks.length > 0 ? `  Blocks: ${task.blocks.join(', ')}` : '';

  const metadataInfo =
    Object.keys(task.metadata).length > 0
      ? `  Metadata: ${JSON.stringify(task.metadata)}`
      : '';

  onProgress?.({ stage: 'completing', percent: 100 });
  ctx.logger.debug('task_get done', { taskId });

  return {
    ok: true,
    output:
      `Task #${task.id}:\n` +
      `  Subject: ${task.subject}\n` +
      `  Description: ${task.description}\n` +
      `  Status: ${task.status}\n` +
      `  Priority: ${task.priority}\n` +
      `  Active Form: ${task.activeForm}\n` +
      (task.owner ? `  Owner: ${task.owner}\n` : '') +
      (blockedByInfo ? `${blockedByInfo}\n` : '') +
      (blocksInfo ? `${blocksInfo}\n` : '') +
      (metadataInfo ? `${metadataInfo}\n` : ''),
    meta: { task },
  };
}

class TaskGetHandler implements ToolHandler<Record<string, unknown>, string> {
  readonly schema = schema;
  async execute(
    args: Record<string, unknown>,
    ctx: ToolContext,
    canUseTool: CanUseToolFn,
    onProgress?: ToolProgressFn,
  ): Promise<ToolResult<string>> {
    return executeTaskGet(args, ctx, canUseTool, onProgress);
  }
}

export const taskGetModule: ToolModule<Record<string, unknown>, string> = {
  schema,
  createHandler() {
    return new TaskGetHandler();
  },
};
