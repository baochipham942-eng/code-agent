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
import { validateScript } from '../../../agent/scriptRuntime/scriptValidator';
import { resolveSessionDefaultModelConfig } from '../../../services/core/sessionDefaults';
import { buildLegacyCtxFromProtocol } from '../_helpers/legacyAdapter';
import { workflowSchema } from './workflow.schema';

// full-agent 路径（agent() 无 schema）的默认工具白名单：读 + 调研。
// 这是 workflow 子 agent 的策略默认值（非易变列表）；模型可在脚本里按需收窄。
// 工具名须与 protocol registry 注册名精确一致（fs 工具是 PascalCase：Read/Glob/Grep）。
const WORKFLOW_DEFAULT_AGENT_TOOLS = ['WebSearch', 'WebFetch', 'Read', 'Glob', 'Grep'];

/** 把异常归类成 ABORTED / DOMAIN_ERROR（Codex R2：取消别被压成 DOMAIN_ERROR）。 */
function isAbort(ctx: ToolContext, err: unknown): boolean {
  return ctx.abortSignal.aborted || (err instanceof Error && err.name === 'AbortError');
}

async function runWorkflow(
  args: Record<string, unknown>,
  ctx: ToolContext,
  canUseTool: CanUseToolFn,
  onProgress: ToolProgressFn | undefined,
): Promise<ToolResult<string>> {
  // 观测面 best-effort：onProgress 抛错不得反向把执行结果翻成失败（Codex R2 MED）。
  const safeProgress: ToolProgressFn = (p) => {
    try { onProgress?.(p); } catch { /* swallow — progress is non-authoritative */ }
  };

  // 顶层 try/catch：canUseTool / buildLegacyCtxFromProtocol / startRun 等任一 await 抛出都兜住，
  // 不炸出 handler；取消归 ABORTED，其余归 DOMAIN_ERROR（Codex R2 MED：加固别只做一半）。
  try {
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
    // 主线程 fail-fast：体积/语法/非法 import-export 在送进 worker 前就拦下（P2-A），
    // 避免"裸 eval 才在 worker 里炸"的不透明失败。
    const scriptCheck = validateScript(script);
    if (!scriptCheck.ok) {
      return { ok: false, error: `invalid workflow script: ${scriptCheck.error}`, code: 'INVALID_ARGS' };
    }
    const goal = typeof args.goal === 'string' ? args.goal : undefined;
    // token 预算（outputTokens）：正整数才生效，硬上限耗尽后 agent() 抛错；缺省 = 不设限。
    const budgetTokens =
      typeof args.budgetTokens === 'number' && Number.isFinite(args.budgetTokens) && args.budgetTokens > 0
        ? Math.floor(args.budgetTokens)
        : undefined;

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
        // override.provider 类型上必填，但运行时防御缺省（Codex R4）：缺省按 base provider 解，
        // 否则只改 model 的同 provider override 会跳过继承分支、甚至按错误默认 provider 解。
        const effectiveProvider = override.provider ?? baseModelConfig.provider;
        const resolved = resolveSessionDefaultModelConfig({ provider: effectiveProvider, model: override.model });
        // 鉴权继承（Codex MED#1 + R2）：configService 未初始化时 resolved 缺 apiKey/baseUrl。
        // 同 provider 下逐字段补齐缺失项（空串也算缺失），避免 model override 把可用凭证 / 自定义 endpoint 静默清空。
        if (effectiveProvider === baseModelConfig.provider) {
          return {
            ...resolved,
            apiKey: resolved.apiKey || baseModelConfig.apiKey,
            baseUrl: resolved.baseUrl || baseModelConfig.baseUrl,
          };
        }
        return resolved;
      },
      deriveSubagentContext: ({ agentId, modelConfig, signal }): SubagentContext => ({
        modelConfig,
        toolResolver: legacyCtx.resolver as ToolResolver,
        // 干净 toolContext：注入 per-agent agentId + per-call modelConfig；显式清空会话/历史承载字段
        // 与父级 call-scoped id（Codex MED#2 + R2：不靠"legacyCtx 恰好没 messages"，且 currentToolCallId
        // 不清会让子 agent 下游按 tool-call id 归因时串到父 workflow 那个 call）。
        toolContext: {
          ...legacyCtx,
          agentId,
          modelConfig,
          // child-scoped signal 也要覆写到 toolContext（Codex R3）：否则下游工具读 toolContext.abortSignal
          // 会拿到 legacyCtx 带下来的父级 signal，绕过 child-scoped cancel/timeout，与 SubagentContext.abortSignal 不一致。
          abortSignal: signal,
          messages: undefined,
          todos: undefined,
          modifiedFiles: undefined,
          currentAttachments: undefined,
          currentToolCallId: undefined,
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
          safeProgress({ stage: 'running', detail: `phase: ${event.data.title}` });
        } else if (event.type === 'agent:start') {
          safeProgress({ stage: 'running', detail: `agent: ${String(event.data?.label ?? 'agent')}` });
        } else if (event.type === 'run:log' && typeof event.data?.message === 'string') {
          safeProgress({ stage: 'running', detail: event.data.message });
        }
      },
    };

    // runId 必须每次调用唯一（Codex HIGH#2）：currentToolCallId 可能缺失、sessionId 会复用，
    // 撞了会让 activeRuns 覆盖 + cancel/状态串线。加 uuid 后缀兜底（主线程可用 randomUUID）。
    const runId = `wf-${ctx.currentToolCallId ?? ctx.sessionId ?? 'run'}-${randomUUID().slice(0, 8)}`;

    safeProgress({ stage: 'starting', detail: 'workflow' });

    const state = await startRun(
      { runId, script, goal, budgetTokens, defaultProvider: baseModelConfig.provider, defaultModel: baseModelConfig.model },
      deps,
    );

    if (state.status !== 'completed') {
      ctx.logger.debug('workflow run did not complete', { status: state.status, error: state.error });
      return {
        ok: false,
        error: `workflow ${state.status}: ${state.error ?? 'unknown error'}`,
        code: state.status === 'cancelled' ? 'ABORTED' : 'DOMAIN_ERROR',
        meta: { runId, status: state.status, agentCallCount: state.agentCallCount, tokensSpent: state.tokensSpent, phases: state.phases },
      };
    }

    // 仅成功路径报完成进度（Codex LOW#3：失败先发 completing 会让 UI 先看到完成再看到报错）。
    safeProgress({ stage: 'completing', percent: 100 });

    // 区分脚本 return undefined（无返回）与显式 null（Codex LOW#1）。
    // 序列化单独兜住（Codex R4 LOW）：BigInt / 循环引用会让 JSON.stringify 抛错，
    // 不兜的话会把一个已 completed 的 run 误包成 DOMAIN_ERROR。
    let resultText: string;
    if (typeof state.result === 'string') {
      resultText = state.result;
    } else if (state.result === undefined) {
      resultText = '(workflow 脚本无返回值)';
    } else {
      try {
        resultText = JSON.stringify(state.result, null, 2);
      } catch {
        resultText = `(workflow 结果无法序列化为 JSON: ${String(state.result)})`;
      }
    }

    return {
      ok: true,
      output: resultText,
      meta: { runId, agentCallCount: state.agentCallCount, tokensSpent: state.tokensSpent, phases: state.phases },
    };
  } catch (err) {
    if (isAbort(ctx, err)) {
      return { ok: false, error: 'workflow aborted', code: 'ABORTED' };
    }
    const msg = err instanceof Error ? err.message : String(err);
    ctx.logger.debug('workflow handler threw', { error: msg });
    return { ok: false, error: `workflow run failed: ${msg}`, code: 'DOMAIN_ERROR' };
  }
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
