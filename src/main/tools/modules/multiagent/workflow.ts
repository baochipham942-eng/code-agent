// ============================================================================
// workflow —— dynamic-workflow 命令式脚本运行时的命令层入口（P1 收尾 ②）
//
// 模型当场写的 JS 编排脚本经 script 参数到这里：本工具把 protocol ToolContext 桥接成
// scriptRuntime 需要的宿主依赖（ScriptRunHostDeps），调 startRun 在受限 worker 沙箱跑脚本。
//
// 关键接线（与 spawnAgent 同源）：
//   - baseModelConfig      = ctx.modelConfig（主 agent 当前已解析的 ModelConfig，含 apiKey）
//   - resolveModelConfig   = per-call override → resolveSessionDefaultModelConfig（含 apiKey/baseUrl）
//   - deriveSubagentContext= 为无-schema 的 full-agent 路径派生干净 SubagentContext
//                            （toolResolver=ctx.resolver、toolContext={...legacyCtx,agentId}，不灌历史）
//   - defaultAgentTools    = full-agent 路径默认工具白名单
//
// 「中间结果不进主 context」：scriptRuntime 内部 agent() 直连 executor/inferenceViaAiSdk，
// 绕开 spawn_agent/workflowOrchestrate/parallelCoordinator/cowork 四条会灌历史的高层入口；
// 本工具只回传脚本 return 的最终结果。
// ============================================================================

import { randomUUID } from 'node:crypto';
import type {
  ToolHandler,
  ToolModule,
  ToolContext,
  CanUseToolFn,
  ToolProgressFn,
  ToolResult,
} from '../../../protocol/tools';
import type { ModelConfig } from '../../../../shared/contract';
import type { ToolResolver } from '../../dispatch/toolResolver';
import type { SubagentContext } from '../../../agent/subagentExecutor';
import { startRun, type ScriptRunHostDeps } from '../../../agent/scriptRuntime';
import type { ScriptRunEvent } from '../../../agent/scriptRuntime';
import { resolveSessionDefaultModelConfig } from '../../../services/core/sessionDefaults';
import { buildLegacyCtxFromProtocol } from '../_helpers/legacyAdapter';
import { workflowSchema } from './workflow.schema';

// full-agent 路径（agent() 无 schema）的默认工具白名单：读 + 调研。
// 这是 workflow 子 agent 的策略默认值（非易变列表）；模型可在脚本里按需收窄。
// 工具名须与 protocol registry 注册名精确一致（fs 工具是 PascalCase：Read/Glob/Grep）。
const WORKFLOW_DEFAULT_AGENT_TOOLS = ['WebSearch', 'WebFetch', 'Read', 'Glob', 'Grep'];

async function runWorkflow(
  args: Record<string, unknown>,
  ctx: ToolContext,
  canUseTool: CanUseToolFn,
  onProgress: ToolProgressFn | undefined,
): Promise<ToolResult<string>> {
  const permit = await canUseTool(workflowSchema.name, args);
  if (!permit.allow) {
    return { ok: false, error: `permission denied: ${permit.reason}`, code: 'PERMISSION_DENIED' };
  }
  if (ctx.abortSignal.aborted) {
    return { ok: false, error: 'aborted', code: 'ABORTED' };
  }

  const script = args.script;
  if (typeof script !== 'string' || script.trim().length === 0) {
    return { ok: false, error: 'workflow requires a non-empty `script` string', code: 'INVALID_ARGS' };
  }
  const goal = typeof args.goal === 'string' ? args.goal : undefined;

  if (!ctx.modelConfig) {
    return { ok: false, error: 'workflow requires modelConfig in context', code: 'NOT_INITIALIZED' };
  }
  const baseModelConfig = ctx.modelConfig as ModelConfig;

  // legacy ctx 提供 resolver / hookManager / workingDirectory / sessionId（与 spawnAgent 同源桥接）。
  const legacyCtx = buildLegacyCtxFromProtocol(ctx, canUseTool);

  const deps: ScriptRunHostDeps = {
    baseModelConfig,
    resolveModelConfig: (override) => {
      if (!override) return baseModelConfig;
      const resolved = resolveSessionDefaultModelConfig({ provider: override.provider, model: override.model });
      // 鉴权继承（Codex MED#1）：configService 未初始化时 resolved.apiKey 为空。
      // 同 provider 下继承 base 的 apiKey/baseUrl，避免 model override 把可用凭证静默清空。
      if (!resolved.apiKey && override.provider === baseModelConfig.provider) {
        return { ...resolved, apiKey: baseModelConfig.apiKey, baseUrl: resolved.baseUrl ?? baseModelConfig.baseUrl };
      }
      return resolved;
    },
    deriveSubagentContext: ({ agentId, modelConfig, signal }): SubagentContext => ({
      modelConfig,
      toolResolver: legacyCtx.resolver as ToolResolver,
      // 干净 toolContext：注入 per-agent agentId + per-call modelConfig；显式清空会话/历史承载字段
      // （Codex MED#2：不靠"legacyCtx 当前恰好没 messages"，防 buildLegacyCtxFromProtocol 未来加字段时静默泄漏）。
      toolContext: {
        ...legacyCtx,
        agentId,
        modelConfig,
        messages: undefined,
        todos: undefined,
        modifiedFiles: undefined,
        currentAttachments: undefined,
      } as SubagentContext['toolContext'],
      abortSignal: signal,
      executionAgentId: agentId,
      hookManager: legacyCtx.hookManager,
    }),
    defaultAgentTools: WORKFLOW_DEFAULT_AGENT_TOOLS,
    signal: ctx.abortSignal,
    emit: (event: ScriptRunEvent) => {
      // run 事件 → onProgress 进度行（不耦合 AgentEvent 协议）。
      if (event.type === 'run:phase' && typeof event.data?.title === 'string') {
        onProgress?.({ stage: 'running', detail: `phase: ${event.data.title}` });
      } else if (event.type === 'agent:start') {
        onProgress?.({ stage: 'running', detail: `agent: ${String(event.data?.label ?? 'agent')}` });
      } else if (event.type === 'run:log' && typeof event.data?.message === 'string') {
        onProgress?.({ stage: 'running', detail: event.data.message });
      }
    },
  };

  // runId 必须每次调用唯一（Codex HIGH#2）：currentToolCallId 可能缺失、sessionId 会复用，
  // 撞了会让 activeRuns 覆盖 + cancel/状态串线。加 uuid 后缀兜底（主线程可用 randomUUID）。
  const runId = `wf-${ctx.currentToolCallId ?? ctx.sessionId ?? 'run'}-${randomUUID().slice(0, 8)}`;

  onProgress?.({ stage: 'starting', detail: 'workflow' });

  // startRun 可能同步/异步抛（worker 创建失败、deps 异常等）——兜住，别炸出 handler（Codex MED#3）。
  let state;
  try {
    state = await startRun(
      {
        runId,
        script,
        goal,
        defaultProvider: baseModelConfig.provider,
        defaultModel: baseModelConfig.model,
      },
      deps,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    ctx.logger.debug('workflow startRun threw', { runId, error: msg });
    return { ok: false, error: `workflow run failed: ${msg}`, code: 'DOMAIN_ERROR', meta: { runId } };
  }

  if (state.status !== 'completed') {
    ctx.logger.debug('workflow run did not complete', { status: state.status, error: state.error });
    return {
      ok: false,
      error: `workflow ${state.status}: ${state.error ?? 'unknown error'}`,
      code: state.status === 'cancelled' ? 'ABORTED' : 'DOMAIN_ERROR',
      meta: { runId, status: state.status, agentCallCount: state.agentCallCount, phases: state.phases },
    };
  }

  // 仅成功路径报完成进度（Codex LOW#3：失败先发 completing 会让 UI 先看到完成再看到报错）。
  onProgress?.({ stage: 'completing', percent: 100 });

  // 区分脚本 return undefined（无返回）与显式 null（Codex LOW#1）。
  const resultText =
    typeof state.result === 'string'
      ? state.result
      : state.result === undefined
        ? '(workflow 脚本无返回值)'
        : JSON.stringify(state.result, null, 2);

  return {
    ok: true,
    output: resultText,
    meta: { runId, agentCallCount: state.agentCallCount, phases: state.phases },
  };
}

function makeHandler(): ToolHandler<Record<string, unknown>, string> {
  return {
    schema: workflowSchema,
    async execute(args, ctx, canUseTool, onProgress) {
      return runWorkflow(args, ctx, canUseTool, onProgress);
    },
  };
}

export const workflowModule: ToolModule<Record<string, unknown>, string> = {
  schema: workflowSchema,
  createHandler() {
    return makeHandler();
  },
};
