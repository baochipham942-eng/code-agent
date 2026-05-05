// ============================================================================
// TaskManager (P1 Wave 3 — planning: native ToolModule rewrite)
//
// 旧版: src/main/tools/planning/TaskManagerTool.ts
// 改造点：
// - 4 参数签名 (args, ctx, canUseTool, onProgress)
// - 五链 + 错误码：INVALID_ARGS / PERMISSION_DENIED / ABORTED
// - 直接 dispatch 到 native sub-tool (executeTaskCreate/Get/List/Update)
//   不再走 legacy Tool 委托——native ToolModule chain
// - 行为保真：unknown action → INVALID_ARGS with valid list
// ============================================================================

import type {
  ToolHandler,
  ToolModule,
  ToolContext,
  CanUseToolFn,
  ToolProgressFn,
  ToolResult,
} from '../../../protocol/tools';
import { taskManagerSchema as schema } from './taskManager.schema';
import { executeTaskCreate } from './taskCreate';
import { executeTaskGet } from './taskGet';
import { executeTaskList } from './taskList';
import { executeTaskUpdate } from './taskUpdate';

export async function executeTaskManager(
  args: Record<string, unknown>,
  ctx: ToolContext,
  canUseTool: CanUseToolFn,
  onProgress?: ToolProgressFn,
): Promise<ToolResult<string>> {
  const action = args.action;

  // 五链顺序：先 canUseTool/abort 再 dispatch（也让子工具再各自 canUseTool 一次，
  // 但 facade 层面要先把"不允许 TaskManager"挡掉）
  const permit = await canUseTool(schema.name, args);
  if (!permit.allow) {
    return { ok: false, error: `permission denied: ${permit.reason}`, code: 'PERMISSION_DENIED' };
  }
  if (ctx.abortSignal.aborted) {
    return { ok: false, error: 'aborted', code: 'ABORTED' };
  }

  onProgress?.({ stage: 'starting', detail: schema.name });

  switch (action) {
    case 'create':
      return executeTaskCreate(args, ctx, canUseTool, onProgress);
    case 'get':
      return executeTaskGet(args, ctx, canUseTool, onProgress);
    case 'list':
      return executeTaskList(args, ctx, canUseTool, onProgress);
    case 'update':
      return executeTaskUpdate(args, ctx, canUseTool, onProgress);
    default:
      return {
        ok: false,
        error: `Unknown action: ${String(action)}. Valid actions: create, get, list, update`,
        code: 'INVALID_ARGS',
      };
  }
}

class TaskManagerHandler implements ToolHandler<Record<string, unknown>, string> {
  readonly schema = schema;
  async execute(
    args: Record<string, unknown>,
    ctx: ToolContext,
    canUseTool: CanUseToolFn,
    onProgress?: ToolProgressFn,
  ): Promise<ToolResult<string>> {
    return executeTaskManager(args, ctx, canUseTool, onProgress);
  }
}

export const taskManagerModule: ToolModule<Record<string, unknown>, string> = {
  schema,
  createHandler() {
    return new TaskManagerHandler();
  },
};
