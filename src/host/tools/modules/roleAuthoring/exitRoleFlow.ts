// ============================================================================
// exit_role_flow — 退出建/改角色严格流程（草稿不动）
//
// create-role/edit-role 的 strict toolset 会把可见工具硬收缩到 5 个左右；用户在
// 流程中途提出无关请求时，模型调用本工具声明退出。工具本体触达不到 turn 状态，
// 真正的解除在两处接线：
//   1) 同轮立即生效：toolExecutionEngine 在本工具执行成功后清 turn.skillToolBoundary；
//   2) 跨轮不再恢复：sticky 扫描（conversationRuntimeStickySkill）看到种子之后
//      历史里出现过本工具调用即停止恢复。
// ============================================================================

import type {
  ToolHandler,
  ToolModule,
  ToolContext,
  CanUseToolFn,
  ToolResult,
  ToolSchema,
} from '../../../protocol/tools';
import { exitRoleFlowSchema } from './exitRoleFlow.schema';

const schema: ToolSchema = exitRoleFlowSchema;

class ExitRoleFlowHandler implements ToolHandler<Record<string, unknown>, string> {
  readonly schema = schema;

  async execute(
    args: Record<string, unknown>,
    ctx: ToolContext,
    _canUseTool: CanUseToolFn,
  ): Promise<ToolResult<string>> {
    if (ctx.abortSignal.aborted) {
      return { ok: false, error: 'aborted', code: 'ABORTED' };
    }
    const reason = typeof args.reason === 'string' ? args.reason.trim() : '';
    ctx.logger.info('exit_role_flow invoked', { reason: reason || '(none)' });
    return {
      ok: true,
      output:
        '已退出建/改角色流程。完整工具集从下一步起恢复可用；未确认的角色草稿仍保留在确认卡上，用户随时可以回来确认。' +
        '现在直接继续处理用户的请求。',
      meta: { exitedRoleFlow: true, reason: reason || undefined },
    };
  }
}

export const exitRoleFlowModule: ToolModule<Record<string, unknown>, string> = {
  schema,
  createHandler() {
    return new ExitRoleFlowHandler();
  },
};
