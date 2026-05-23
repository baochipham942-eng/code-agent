// ============================================================================
// attempt_completion — /goal 自治循环的"申请退出"信号工具
//
// 真正的处理在 messageProcessor 拦截：那里能拿到 RuntimeContext.goalMode，
// 调 requestCompletion(summary) 后由 loop 编排闸1/闸2 验证。
// 本 executor 只是兜底——当非 goal 模式（无拦截）误调用时，给一句无害提示，
// 不产生任何副作用。
// ============================================================================

import type {
  ToolHandler,
  ToolModule,
  ToolContext,
  CanUseToolFn,
  ToolProgressFn,
  ToolResult,
} from '../../../protocol/tools';
import { attemptCompletionSchema as schema } from './attemptCompletion.schema';

export async function executeAttemptCompletion(
  _args: Record<string, unknown>,
  _ctx: ToolContext,
  _canUseTool: CanUseToolFn,
  _onProgress?: ToolProgressFn,
): Promise<ToolResult<string>> {
  return {
    ok: true,
    output: 'attempt_completion 仅在 /goal 自治模式下生效；当前非 goal 模式，本次调用无操作。',
  };
}

class AttemptCompletionHandler implements ToolHandler<Record<string, unknown>, string> {
  readonly schema = schema;
  async execute(
    args: Record<string, unknown>,
    ctx: ToolContext,
    canUseTool: CanUseToolFn,
    onProgress?: ToolProgressFn,
  ): Promise<ToolResult<string>> {
    return executeAttemptCompletion(args, ctx, canUseTool, onProgress);
  }
}

export const attemptCompletionModule: ToolModule<Record<string, unknown>, string> = {
  schema,
  createHandler() {
    return new AttemptCompletionHandler();
  },
};
