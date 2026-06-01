// ============================================================================
// TaskList (P1 Wave 3 — planning: native ToolModule rewrite)
//
// 旧版: src/main/tools/planning/taskList.ts
// 改造点：
// - 4 参数签名 (args, ctx, canUseTool, onProgress)
// - 五链 + 错误码：PERMISSION_DENIED / ABORTED
// - 行为保真：sessionId 默认 'default' / statusIcon (●◐○) / blockedBy 检测 /
//   stats 行 / metadata.tasks 字段 1:1
// ============================================================================

import type {
  ToolHandler,
  ToolModule,
  ToolContext,
  CanUseToolFn,
  ToolProgressFn,
  ToolResult,
} from '../../../protocol/tools';
import { isClosedTaskStatus, listTasks } from '../../../services/planning/taskStore';
import { taskListSchema as schema } from './taskList.schema';

export async function executeTaskList(
  args: Record<string, unknown>,
  ctx: ToolContext,
  canUseTool: CanUseToolFn,
  onProgress?: ToolProgressFn,
): Promise<ToolResult<string>> {
  const permit = await canUseTool(schema.name, args);
  if (!permit.allow) {
    return { ok: false, error: `permission denied: ${permit.reason}`, code: 'PERMISSION_DENIED' };
  }
  if (ctx.abortSignal.aborted) {
    return { ok: false, error: 'aborted', code: 'ABORTED' };
  }

  onProgress?.({ stage: 'starting', detail: schema.name });

  const sessionId = ctx.sessionId || 'default';
  const tasks = listTasks(sessionId);

  if (tasks.length === 0) {
    onProgress?.({ stage: 'completing', percent: 100 });
    return {
      ok: true,
      output: 'No tasks in this session. Use task_create to create new tasks.',
    };
  }

  const taskSummaries = tasks.map((task) => {
    const statusIcon =
      task.status === 'completed' ? '●' : task.status === 'in_progress' ? '◐' : task.status === 'cancelled' ? '⊘' : '○';

    const openBlockers = task.blockedBy.filter((id) => {
      const blocker = tasks.find((t) => t.id === id);
      return blocker && !isClosedTaskStatus(blocker.status);
    });

    const blockedInfo =
      openBlockers.length > 0 ? ` [blocked by: ${openBlockers.join(', ')}]` : '';

    const ownerInfo = task.owner ? ` (@${task.owner})` : '';

    return `${statusIcon} #${task.id}: ${task.subject}${ownerInfo}${blockedInfo}`;
  });

  const completed = tasks.filter((t) => t.status === 'completed').length;
  const inProgress = tasks.filter((t) => t.status === 'in_progress').length;
  const pending = tasks.filter((t) => t.status === 'pending').length;
  const cancelled = tasks.filter((t) => t.status === 'cancelled').length;
  const blocked = tasks.filter((t) => {
    const openBlockers = t.blockedBy.filter((id) => {
      const blocker = tasks.find((bt) => bt.id === id);
      return blocker && !isClosedTaskStatus(blocker.status);
    });
    return openBlockers.length > 0 && !isClosedTaskStatus(t.status);
  }).length;

  onProgress?.({ stage: 'completing', percent: 100 });
  ctx.logger.debug('task_list done', { count: tasks.length });

  return {
    ok: true,
    output:
      `Tasks (${completed}/${tasks.length} completed):\n` +
      taskSummaries.join('\n') +
      '\n\n' +
      `Status: ${completed} completed, ${inProgress} in progress, ${pending} pending` +
      (cancelled > 0 ? `, ${cancelled} cancelled` : '') +
      (blocked > 0 ? `, ${blocked} blocked` : ''),
    meta: {
      tasks: tasks.map((t) => ({
        id: t.id,
        subject: t.subject,
        status: t.status,
        owner: t.owner,
        blockedBy: t.blockedBy,
      })),
      stats: { total: tasks.length, completed, inProgress, pending, cancelled, blocked },
    },
  };
}

class TaskListHandler implements ToolHandler<Record<string, unknown>, string> {
  readonly schema = schema;
  async execute(
    args: Record<string, unknown>,
    ctx: ToolContext,
    canUseTool: CanUseToolFn,
    onProgress?: ToolProgressFn,
  ): Promise<ToolResult<string>> {
    return executeTaskList(args, ctx, canUseTool, onProgress);
  }
}

export const taskListModule: ToolModule<Record<string, unknown>, string> = {
  schema,
  createHandler() {
    return new TaskListHandler();
  },
};
