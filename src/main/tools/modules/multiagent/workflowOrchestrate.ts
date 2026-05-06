// ============================================================================
// WorkflowOrchestrate (P1 Wave 3 — multiagent: native ToolModule rewrite)
//
// 旧版: src/main/agent/multiagentTools/workflowOrchestrate.ts
//   - workflowOrchestrateTool: Tool / WorkflowOrchestrateTool: Tool 已删
//   - executeWorkflowOrchestrate(params, legacyCtx) 保留作业务函数
// 改造点：
// - 4 参数签名 (args, ctx, canUseTool, onProgress)
// - 五链 + 错误码：PERMISSION_DENIED / ABORTED / NOT_INITIALIZED / DOMAIN_ERROR
// - schema 在 ./workflowOrchestrate.schema.ts，含 dynamicDescription（注入
//   listBuiltInWorkflows() 的可用工作流列表）
//
// Opaque service handle 模式：
//   workflow_orchestrate 用 ctx.modelConfig (cast ModelConfig) +
//   ctx.resolver (cast ToolResolver) + ctx.subagent.attachments （多模态附件
//   传给 stage subagent）+ ctx.sessionId。我们用 buildLegacyCtxFromProtocol 桥接
//   （cross-cat dispatch），保持 545 行业务逻辑不动。TODO Wave 4 升 SubagentExecutor
//   接 ProtocolToolContext 后可移除 _helpers/legacyAdapter 依赖。
// ============================================================================

import type {
  ToolHandler,
  ToolModule,
  ToolContext,
  CanUseToolFn,
  ToolProgressFn,
  ToolResult,
} from '../../../protocol/tools';
import { executeWorkflowOrchestrate as executeWorkflowOrchestrateLegacy } from '../../../agent/multiagentTools/workflowOrchestrate';
import { buildLegacyCtxFromProtocol, adaptLegacyResult } from '../_helpers/legacyAdapter';
import { workflowOrchestrateSchema as schema } from './workflowOrchestrate.schema';

class WorkflowOrchestrateHandler implements ToolHandler<Record<string, unknown>, string> {
  readonly schema = schema;
  async execute(
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
    if (!ctx.modelConfig) {
      return {
        ok: false,
        error: 'workflow_orchestrate requires modelConfig in context',
        code: 'NOT_INITIALIZED',
      };
    }

    onProgress?.({ stage: 'starting', detail: schema.name });
    const legacyCtx = buildLegacyCtxFromProtocol(ctx, canUseTool);
    const legacyResult = await executeWorkflowOrchestrateLegacy(args, legacyCtx);
    onProgress?.({ stage: 'completing', percent: 100 });
    ctx.logger.debug('workflow_orchestrate done', { ok: legacyResult.success });
    return adaptLegacyResult(legacyResult);
  }
}

export const workflowOrchestrateModule: ToolModule<Record<string, unknown>, string> = {
  schema,
  createHandler() {
    return new WorkflowOrchestrateHandler();
  },
};
