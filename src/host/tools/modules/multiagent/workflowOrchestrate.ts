// ============================================================================
// WorkflowOrchestrate (P1 Wave 3 — multiagent: native ToolModule rewrite)
//
// 业务执行由 protocol-native workflow service 承担。
// 改造点：
// - 4 参数签名 (args, ctx, canUseTool, onProgress)
// - 五链 + 错误码：PERMISSION_DENIED / ABORTED / NOT_INITIALIZED / DOMAIN_ERROR
// - schema 在 ./workflowOrchestrate.schema.ts，含 dynamicDescription（注入
//   listBuiltInWorkflows() 的可用工作流列表）
//
// Protocol context 在入口一次性投影为显式 execution ports。
// ============================================================================

import type {
  ToolHandler,
  ToolModule,
  ToolContext,
  CanUseToolFn,
  ToolProgressFn,
  ToolResult,
} from '../../../protocol/tools';
import { executeWorkflowOrchestrate } from '../../../agent/multiagentTools/workflowOrchestrate';
import { createProtocolSubagentExecutionContext } from '../../../agent/subagentExecutionContext';
import type { SubagentExecutionContext } from '../../../agent/subagentExecutorTypes';
import type { ToolResolver } from '../../dispatch/toolResolver';
import { workflowOrchestrateSchema as schema } from './workflowOrchestrate.schema';
import { withMultiagentMeta } from './resultMeta';
import { AgentFailureCode } from '../../../../shared/contract/agentFailure';

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
      return {
        ok: false,
        error: `permission denied: ${permit.reason}`,
        code: 'PERMISSION_DENIED',
        meta: { failureCode: AgentFailureCode.PermissionDenied },
      };
    }
    if (ctx.abortSignal.aborted) {
      return {
        ok: false,
        error: 'aborted',
        code: 'ABORTED',
        meta: { failureCode: AgentFailureCode.CancelledByUser },
      };
    }
    if (!ctx.modelConfig) {
      return {
        ok: false,
        error: 'workflow_orchestrate requires modelConfig in context',
        code: 'NOT_INITIALIZED',
        meta: { failureCode: AgentFailureCode.ModelError },
      };
    }

    onProgress?.({ stage: 'starting', detail: schema.name });
    let executionContext: SubagentExecutionContext;
    try {
      executionContext = createProtocolSubagentExecutionContext(ctx, canUseTool, {
        resolver: ctx.resolver as ToolResolver | undefined,
        progress: (stage, detail, percent) => onProgress?.({ stage, detail, percent }),
      });
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        code: 'NOT_INITIALIZED',
        meta: { failureCode: AgentFailureCode.ModelError },
      };
    }
    const serviceResult = await executeWorkflowOrchestrate(args, executionContext);
    onProgress?.({ stage: 'completing', percent: 100 });
    ctx.logger.debug('workflow_orchestrate done', { ok: serviceResult.success });
    const result: ToolResult<string> = serviceResult.success
      ? { ok: true, output: serviceResult.output ?? '', meta: serviceResult.metadata }
      : { ok: false, error: serviceResult.error ?? 'unknown error', meta: serviceResult.metadata };
    return withMultiagentMeta(result, ctx, schema.name, {
      action: 'workflow',
      status: result.ok ? 'completed' : 'failed',
      targets: [
        typeof args.workflow === 'string' ? args.workflow : undefined,
        ...(Array.isArray(args.stages)
          ? args.stages
            .map((stage) => (stage && typeof stage === 'object' && 'name' in stage ? (stage as { name?: unknown }).name : undefined))
            .filter((name): name is string => typeof name === 'string')
          : []),
      ].filter((target): target is string => typeof target === 'string'),
      counts: {
        stages: Array.isArray(args.stages) ? args.stages.length : undefined,
      },
      result: serviceResult.metadata ?? {},
    }, {
      artifactName: 'Workflow result',
      requestArgs: args,
      legacyMetadata: serviceResult.metadata,
      // Public metadata compatibility: keep the historical bridge flag stable
      // even though execution no longer traverses the legacy adapter.
      legacyContext: true,
    });
  }
}

export const workflowOrchestrateModule: ToolModule<Record<string, unknown>, string> = {
  schema,
  createHandler() {
    return new WorkflowOrchestrateHandler();
  },
};
