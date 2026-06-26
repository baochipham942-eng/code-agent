// ============================================================================
// TaskCreate (P1 Wave 3 — planning: native ToolModule rewrite)
//
// 旧版: src/main/tools/planning/taskCreate.ts
// 改造点：
// - 4 参数签名 (args, ctx, canUseTool, onProgress)
// - 五链 + 错误码：INVALID_ARGS / PERMISSION_DENIED / ABORTED
// - 行为保真：sessionId fallback / priority 默认 'normal' / metadata 默认 {} /
//   ctx.emit('task_update', {tasks, action: 'create', taskId}) 透传 /
//   "Task #X created:" + Subject/Status/Priority/Active Form 输出 1:1
// ============================================================================

import type {
  ToolHandler,
  ToolModule,
  ToolContext,
  CanUseToolFn,
  ToolProgressFn,
  ToolResult,
} from '../../../protocol/tools';
import type { SessionTaskPriority } from '../../../../shared/contract/planning';
import { createTask, listTasks } from '../../../services/planning/taskStore';
import { taskCreateSchema as schema } from './taskCreate.schema';

export async function executeTaskCreate(
  args: Record<string, unknown>,
  ctx: ToolContext,
  canUseTool: CanUseToolFn,
  onProgress?: ToolProgressFn,
): Promise<ToolResult<string>> {
  const subject = args.subject;
  const description = args.description;
  const activeForm = args.activeForm as string | undefined;
  const priority = (args.priority as SessionTaskPriority | undefined) || 'normal';
  const metadata = (args.metadata as Record<string, unknown> | undefined) || {};
  const parentTaskId = typeof args.parentTaskId === 'string' && args.parentTaskId ? args.parentTaskId : undefined;
  // owner 语义（roadmap 2.6）：显式传入优先；subagent 内创建的任务默认归该
  // subagent，subagent 结束时未收口任务由 orphan 接管回主会话
  const explicitOwner = typeof args.owner === 'string' && args.owner ? args.owner : undefined;
  const owner = explicitOwner ?? (ctx.agentId?.startsWith('subagent_') ? ctx.agentId : undefined);

  if (!subject || typeof subject !== 'string') {
    return { ok: false, error: 'subject is required and must be a string', code: 'INVALID_ARGS' };
  }
  if (!description || typeof description !== 'string') {
    return {
      ok: false,
      error: 'description is required and must be a string',
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
  let task;
  try {
    task = createTask(sessionId, {
      subject,
      description,
      activeForm,
      priority,
      metadata,
      parentTaskId,
      owner,
    });
  } catch (err) {
    // 树状结构（roadmap 2.6）：父任务必须存在
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      code: 'INVALID_ARGS',
    };
  }

  // 行为保真：legacy 通过 context.emit?.('task_update', ...)
  (ctx.emit as unknown as ((event: string, payload: unknown) => void) | undefined)?.(
    'task_update',
    {
      tasks: listTasks(sessionId),
      action: 'create',
      taskId: task.id,
    },
  );

  onProgress?.({ stage: 'completing', percent: 100 });
  ctx.logger.debug('task_create done', { taskId: task.id });

  return {
    ok: true,
    output:
      `Task #${task.id} created:\n` +
      `  Subject: ${task.subject}\n` +
      `  Status: ${task.status}\n` +
      `  Priority: ${task.priority}\n` +
      `  Active Form: ${task.activeForm}`,
    meta: {
      taskId: task.id,
      task,
    },
  };
}

class TaskCreateHandler implements ToolHandler<Record<string, unknown>, string> {
  readonly schema = schema;
  async execute(
    args: Record<string, unknown>,
    ctx: ToolContext,
    canUseTool: CanUseToolFn,
    onProgress?: ToolProgressFn,
  ): Promise<ToolResult<string>> {
    return executeTaskCreate(args, ctx, canUseTool, onProgress);
  }
}

export const taskCreateModule: ToolModule<Record<string, unknown>, string> = {
  schema,
  createHandler() {
    return new TaskCreateHandler();
  },
};
