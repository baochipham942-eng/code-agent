// ============================================================================
// workflow —— dynamic-workflow 命令式脚本运行时的命令层入口（P1 收尾 ②）
//
// 模型当场写的 JS 编排脚本经 script 参数到这里：本工具把 protocol ToolContext 桥接成
// scriptRuntime 需要的宿主依赖（ScriptRunHostDeps），调 startRun 在独立受限子进程跑脚本。
//
// 关键接线（与 spawnAgent 同源）：
//   - baseModelConfig      = ctx.modelConfig（主 agent 当前已解析的 ModelConfig，含 apiKey）
//   - resolveModelConfig   = per-call override → resolveSessionDefaultModelConfig（含 apiKey/baseUrl）
//   - deriveSubagentContext= 为无-schema 的 full-agent 路径派生干净 SubagentContext
//                            （toolResolver=ctx.resolver、toolContext={...legacyCtx,agentId}，不灌历史）
//   - resolveAgentTools    = 把 agent({tools}) 的档名解析成工具白名单（readonly/edit/full）
//
// 「中间结果不进主 context」：scriptRuntime 内部 agent() 直连 executor/inferenceViaAiSdk，
// 绕开 spawn_agent/workflowOrchestrate/parallelCoordinator/cowork 四条会灌历史的高层入口；
// 本工具只回传脚本 return 的最终结果。
// ============================================================================

import { randomUUID } from 'node:crypto';
import { SCRIPT_RUNTIME } from '../../../../shared/constants';
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
import type { SubagentContext } from '../../../agent/subagentExecutorTypes';
import type { ScriptRunHostDeps, ScriptRunJournal } from '../../../agent/scriptRuntime';
import type { ScriptRunEvent, ScriptRunState } from '../../../agent/scriptRuntime';
import {
  DAGGraphSchedulerAdapter,
  DynamicWorkflowExecutor,
  GraphEventCompatibilityAdapter,
  GraphExecutorRegistry,
  GraphRunner,
  type GraphRunSpec,
} from '../../../orchestration';
import type { RunTraceContext } from '../../../telemetry/runTraceContext';
import { getWorkflowJournalRepository } from '../../../services/core/repositories/WorkflowJournalRepository';
import { validateScript } from '../../../agent/scriptRuntime/scriptValidator';
import { extractScriptPreview } from '../../../agent/scriptRuntime/scriptPreview';
import { resolveToolProfile } from '../../../agent/scriptRuntime/toolProfiles';
import { resolveSessionDefaultModelConfig } from '../../../services/core/sessionDefaults';
import { buildLegacyCtxFromProtocol } from '../_helpers/legacyAdapter';
import { createProtocolSubagentExecutionContext } from '../../../agent/subagentExecutionContext';
import { getEventBus } from '../../../services/eventing/bus';
import { getWorkflowLaunchApprovalGate, buildWorkflowLaunchRequest } from '../../../agent/workflowLaunchApproval';
import {
  buildRecoveryPriorProjection,
  buildWorkflowFailureRecoveryProposal,
  recordLongTaskRecoveryProposal,
} from '../../../handoff/longTaskRecoveryProposal';
import { getPtcProjectedTools, isPtcEnabled, workflowSchema } from './workflow.schema';
import {
  cleanupAgentWorktree,
  createAgentWorktree,
  discardAgentWorktree,
} from '../../../agent/agentWorktree';

/**
 * PTC（Code Mode）执行侧接线：把脚本里的 `tools.<name>(args)` 接到**本次 workflow
 * 调用所在的那个 ToolExecutor**（`ctx.executeTool`，由 executor 在构造 context 时绑定）。
 *
 * 三条承重决定，都不是这里发明的：
 * ① **不另造 executor**。收缩档（effectiveMode）/ 拓扑 / 审批通道 / subagentPolicy
 *    全部靠「同一个实例 + 原样透传 options」继承。把收缩档复制一份往下游引，
 *    就是给它留漂移的机会，而漂宽一档就是扩权洞（toolExecutor.ts forRun 那条注释的教训）。
 * ② **不另开旁路**。`resolveProtocolTool(name)` 直呼 handler 会绕过 pre-execute/审批/guards，
 *    正是 dsh「共用同一套执行内核，只是入口不同」要保住的那条。
 * ③ **名单与下发侧同源**（`getPtcProjectedTools`），再按本轮 run 级 denylist 收窄——
 *    模型这一轮直接调不到的工具，换个入口也不该调得到。
 *
 * 任一前提缺失 ⇒ 返回空对象 ⇒ 通道关闭（child 侧 `tools` 是空对象）。关闭必须留痕：
 * 静默关闭等于 PTC 悄悄失效且现场零线索。
 */
function buildPtcChannel(ctx: ToolContext): Pick<ScriptRunHostDeps, 'executeTool' | 'visibleToolNames'> {
  if (!isPtcEnabled()) return {};
  if (!ctx.executeTool) {
    ctx.logger.warn('workflow: PTC 已开启但本次调用没有工具执行入口（ctx.executeTool 缺失），PTC 通道关闭');
    return {};
  }
  const denied = new Set((ctx.deniedToolNames ?? []).map((name) => name.trim().toLowerCase()));
  const visibleToolNames = getPtcProjectedTools()
    .map((tool) => tool.name)
    .filter((name) => !denied.has(name.toLowerCase()));
  if (visibleToolNames.length === 0) {
    ctx.logger.warn('workflow: PTC 已开启但可见工具名单为空（注册表未就绪或全被 denylist 收掉），PTC 通道关闭');
    return {};
  }
  const executeTool = ctx.executeTool;
  return {
    visibleToolNames,
    executeTool: async ({ name, args, signal }) => {
      if (signal.aborted) return { ok: false, error: 'run aborted' };
      try {
        const result = await executeTool(name, args);
        return result.success
          ? { ok: true, value: result.result }
          // 这条文案的读者是模型（child 侧包成 ToolCallError.message），走英文稳定串
          : { ok: false, error: result.error ?? `${name} failed without an error message` };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}

/**
 * PTC 脚本的写风险：`tools.<name>()` 里只要有一个不是只读工具，这段脚本就能写。
 * 跑前审批闸的超时授权按 writeHint 分档（只读自动批准 / 含写自动拒绝），而 writeHint
 * 原本只看 `agent({tools:'edit'})`——PTC 通道让脚本能绕过子 agent 直接写，
 * 不补这一条就是「一段只调 tools.Write 的脚本被当只读自动放行」。
 *
 * fail-closed 三处：计算成员访问（记 '*'）、注册表里查不到的名字、注册表为空，一律算写风险。
 */
function ptcScriptHasWriteRisk(toolCallNames: readonly string[]): boolean {
  if (toolCallNames.length === 0) return false;
  const levels = new Map(getPtcProjectedTools().map((tool) => [tool.name, tool.permissionLevel]));
  return toolCallNames.some((name) => levels.get(name) !== 'read');
}

/** 把异常归类成 ABORTED / DOMAIN_ERROR（Codex R2：取消别被压成 DOMAIN_ERROR）。 */
function isAbort(ctx: ToolContext, err: unknown): boolean {
  return ctx.abortSignal.aborted || (err instanceof Error && err.name === 'AbortError');
}

function truncateOuterOutput(value: string): string {
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.length <= SCRIPT_RUNTIME.MAX_OUTER_OUTPUT_BYTES) return value;
  const marker = `\n[workflow output truncated: exceeded ${SCRIPT_RUNTIME.MAX_OUTER_OUTPUT_BYTES} UTF-8 bytes]`;
  const markerBytes = Buffer.byteLength(marker, 'utf8');
  let end = Math.max(0, SCRIPT_RUNTIME.MAX_OUTER_OUTPUT_BYTES - markerBytes);
  while (end > 0 && (bytes[end] & 0b1100_0000) === 0b1000_0000) end -= 1;
  return `${bytes.subarray(0, end).toString('utf8')}${marker}`;
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
    // resumable：从旧 run 的 journal 重放——重跑确定性脚本，命中的 agent() 瞬时返回不再 inference。
    const resumeFromRunId =
      typeof args.resumeFromRunId === 'string' && args.resumeFromRunId.trim().length > 0
        ? args.resumeFromRunId.trim()
        : undefined;

    if (!ctx.modelConfig) {
      return { ok: false, error: 'workflow requires modelConfig in context', code: 'NOT_INITIALIZED' };
    }
    const baseModelConfig = ctx.modelConfig as ModelConfig;

    // runId 必须每次调用唯一（Codex HIGH#2）：currentToolCallId 可能缺失、sessionId 会复用，
    // 撞了会让 activeRuns 覆盖 + cancel/状态串线。加 uuid 后缀兜底（主线程可用 randomUUID）。
    // 提前到审批前算，审批请求与 run 共用同一 id，便于 renderer 关联。
    const runId = `wf-${ctx.currentToolCallId ?? ctx.sessionId ?? 'run'}-${randomUUID().slice(0, 8)}`;

    // 跑前审批闸（P3b）：静态预览脚本 → 展示 phases/扇出量/动写 + 4 维度成本 → 等用户决策。
    // 无 renderer（headless）自动批准；超时按 writeHint 分档自动决策。拒绝则不 startRun。
    const ptcChannel = buildPtcChannel(ctx);
    const rawPreview = extractScriptPreview(script);
    // PTC 开着时，脚本自己调的工具也算进写风险（通道关着的话脚本压根碰不到 tools）。
    const preview = ptcChannel.executeTool && ptcScriptHasWriteRisk(rawPreview.toolCallNames)
      ? { ...rawPreview, writeHint: true }
      : rawPreview;
    const launchRequest = buildWorkflowLaunchRequest({
      id: runId,
      preview,
      goal,
      budgetTokens,
      sessionId: ctx.sessionId,
      now: Date.now(),
    });
    const approval = await getWorkflowLaunchApprovalGate().requestApproval({ request: launchRequest });
    if (!approval.approved) {
      ctx.logger.debug('workflow launch rejected', { runId, feedback: approval.feedback });
      return {
        ok: false,
        error: `workflow launch rejected${approval.feedback ? `: ${approval.feedback}` : ''}`,
        code: 'ABORTED',
        meta: { runId, autoApproved: approval.autoApproved },
      };
    }

    // legacy ctx 提供 resolver / hookManager / workingDirectory / sessionId（与 spawnAgent 同源桥接）。
    const legacyCtx = buildLegacyCtxFromProtocol(ctx, canUseTool);
    const baseSubagentContext = createProtocolSubagentExecutionContext(ctx, canUseTool, {
      modelConfig: baseModelConfig,
      resolver: ctx.resolver as ToolResolver,
    });

    // resumable journal 网关：DB 就绪才有（getWorkflowJournalRepository() 在未就绪时返 null）→
    // 无则不持久化、不重放，workflow 照常全 live 跑（优雅降级）。sessionId 经闭包带入 onRunStart。
    const journalRepo = getWorkflowJournalRepository();
    const journal: ScriptRunJournal | undefined = journalRepo
      ? {
          loadPriorRun: (rid) => {
            const prior = journalRepo.loadRun(rid);
            if (!prior) return null;
            const calls = new Map<number, { contentHash: string; result: string | Record<string, unknown> }>();
            for (const [idx, c] of prior.calls) calls.set(idx, { contentHash: c.contentHash, result: c.result });
            return {
              run: {
                runId: prior.run.runId,
                scriptHash: prior.run.scriptHash,
                goal: prior.run.goal,
              },
              calls,
            };
          },
          loadPriorCalls: (rid) => {
            const prior = journalRepo.loadRun(rid);
            if (!prior) return null;
            const map = new Map<number, { contentHash: string; result: string | Record<string, unknown> }>();
            for (const [idx, c] of prior.calls) map.set(idx, { contentHash: c.contentHash, result: c.result });
            return map;
          },
          onRunStart: (i) =>
            journalRepo.startRun({ runId: i.runId, scriptHash: i.scriptHash, goal: i.goal, sessionId: ctx.sessionId, startedAt: i.startedAt, workingDir: legacyCtx.workingDirectory }),
          onRunFinish: (i) => journalRepo.finishRun(i),
          onCallComplete: (i) => journalRepo.recordCall(i),
        }
      : undefined;

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
      deriveSubagentContext: ({ agentId, modelConfig, signal, capabilities, workspace }): SubagentContext => ({
        ...baseSubagentContext,
        modelConfig,
        cwd: workspace?.cwd ?? baseSubagentContext.cwd,
        workspace: workspace?.workspace ?? baseSubagentContext.workspace,
        abortSignal: signal,
        currentToolCallId: undefined,
        agentId,
        messages: undefined,
        todos: undefined,
        modifiedFiles: undefined,
        attachments: undefined,
        executionAgentId: agentId,
        worktreePath: workspace?.cwd,
        capabilityManifest: capabilities,
      }),
      // 三档工具策略：readonly(默认) / edit / full，模型经 agent({tools}) 按 agent 选档。
      resolveAgentTools: (profile) => resolveToolProfile(profile),
      ...ptcChannel,
      prepareAgentWorkspace: async ({ agentId, signal }) => {
        if (signal.aborted) throw new Error('run aborted before worktree creation');
        const repoPath = legacyCtx.workingDirectory;
        const info = await createAgentWorktree(agentId, repoPath);
        if (signal.aborted) {
          await discardAgentWorktree(agentId, info.worktreePath, repoPath);
          throw new Error('run aborted during worktree creation');
        }
        return {
          cwd: info.worktreePath,
          workspace: info.worktreePath,
          repoPath,
          branchName: info.branchName,
          baseCommit: info.baseCommit,
        };
      },
      finishAgentWorkspace: async ({ agentId, workspace, outcome }) => {
        if (outcome === 'cancelled') {
          await discardAgentWorktree(agentId, workspace.cwd, workspace.repoPath);
          return { status: 'discarded', branchName: workspace.branchName };
        }
        const cleanup = await cleanupAgentWorktree(
          agentId,
          workspace.cwd,
          workspace.repoPath,
          workspace.baseCommit,
        );
        return cleanup.hasChanges
          ? {
              status: 'preserved',
              cwd: cleanup.worktreePath,
              branchName: cleanup.branchName,
              changedFiles: cleanup.changedFiles?.map((file) => file.path),
              diffSummary: cleanup.diffSummary,
            }
          : { status: 'cleaned', branchName: cleanup.branchName };
      },
      signal: ctx.abortSignal,
      emit: (event: ScriptRunEvent) => {
        // ① 进度树事件通道（P3a）：把【全部】8 类 ScriptRunEvent publish 到 'workflow' domain，
        //    workflow.ipc 的专用 bridge 投递到 renderer 'workflow:event'（Tauri IPC + web SSE 两端）。
        //    bridgeToRenderer:false 避免 Tauri 主进程的通用 EventBridge 再转发一次（重复事件）。
        //    stamp sessionId 进 event payload，供 renderer 会话隔离过滤（Codex R1 HIGH#1：
        //    否则别的会话/tab 会看到不属于自己的进度/goal/promptPreview）。best-effort 不阻断执行。
        try {
          const stamped: ScriptRunEvent = { ...event, sessionId: ctx.sessionId };
          getEventBus().publish('workflow', stamped.type, stamped, { sessionId: ctx.sessionId, bridgeToRenderer: false });
        } catch { /* swallow — 观测面非权威 */ }
        // ② 兼容老进度行：3 类事件 → onProgress（不耦合 AgentEvent 协议）。
        if (event.type === 'run:phase' && typeof event.data?.title === 'string') {
          safeProgress({ stage: 'running', detail: `phase: ${event.data.title}` });
        } else if (event.type === 'agent:start') {
          safeProgress({ stage: 'running', detail: `agent: ${String(event.data?.label ?? 'agent')}` });
        } else if (event.type === 'run:log' && typeof event.data?.message === 'string') {
          safeProgress({ stage: 'running', detail: event.data.message });
        }
      },
      journal,
    };

    safeProgress({ stage: 'starting', detail: 'workflow' });

    const parentRunId = ctx.runId ?? runId;
    const parentNodeId = `dynamic-workflow:${ctx.currentToolCallId ?? runId}`;
    const trace = ctx.traceContext as RunTraceContext | undefined;
    const graphSpec: GraphRunSpec = {
      graphId: `${parentRunId}:${parentNodeId}`,
      runId: parentRunId,
      sessionId: ctx.sessionId,
      attempt: trace?.attempt ?? 1,
      schedulerPolicy: { maxConcurrency: 1 },
      trace: trace ? { traceId: trace.traceId, spanId: trace.spanId } : undefined,
      nodes: [{
        nodeId: parentNodeId,
        kind: 'dynamic_workflow',
        executorRef: 'dynamic_workflow',
        dependencies: [],
        sideEffect: preview.writeHint ? 'unknown' : 'read_only',
        input: {
          script,
          goal: goal ?? null,
          workingDir: legacyCtx.workingDirectory,
          defaultProvider: baseModelConfig.provider,
          defaultModel: baseModelConfig.model,
          budgetTokens: budgetTokens ?? null,
          workflowRunId: runId,
          journalRunId: runId,
          resumeFromRunId: resumeFromRunId ?? null,
        },
      }],
    };
    const compatibility = new GraphEventCompatibilityAdapter({
      script: (event) => {
        if (['agent:start', 'agent:done', 'agent:error'].includes(event.type) && event.data?.agentId === parentNodeId) return;
        deps.emit?.({ ...event, runId });
      },
      diagnostic: (error, event, target) => ctx.logger.debug('graph event compatibility projection failed', {
        error: error instanceof Error ? error.message : String(error),
        graphId: event.graphId,
        target,
      }),
    });
    const dynamicExecutor = new DynamicWorkflowExecutor({ dependenciesFactory: () => deps });
    const graphResult = await new GraphRunner({
      scheduler: new DAGGraphSchedulerAdapter(),
      executors: new GraphExecutorRegistry([dynamicExecutor]),
      emit: (event) => compatibility.emit(event),
      attemptGuard: ({ runId: candidateRunId, attempt }) =>
        candidateRunId === parentRunId && attempt === (trace?.attempt ?? 1),
    }).run(graphSpec);
    const graphNodeResult = graphResult.results[parentNodeId];
    const state = graphNodeResult?.output as unknown as ScriptRunState | undefined;
    if (!state) throw new Error(graphNodeResult?.error ?? 'dynamic workflow Graph executor returned no ScriptRunState');

    if (state.status !== 'completed') {
      ctx.logger.debug('workflow run did not complete', { status: state.status, error: state.error });
      if (state.status !== 'cancelled') {
        recordLongTaskRecoveryProposal(buildWorkflowFailureRecoveryProposal({
          sessionId: ctx.sessionId,
          runId,
          goal,
          status: state.status,
          error: state.error,
          resumeFromRunId: runId,
          cacheHits: state.cacheHits,
          phaseCount: state.phases.length,
          priorProjection: buildRecoveryPriorProjection(ctx.sessionId),
        }));
      }
      return {
        ok: false,
        error: `workflow ${state.status}: ${state.error ?? 'unknown error'}`,
        code: state.status === 'cancelled' ? 'ABORTED' : 'DOMAIN_ERROR',
        meta: {
          runId, status: state.status, agentCallCount: state.agentCallCount,
          tokensSpent: state.tokensSpent, cacheHits: state.cacheHits, phases: state.phases,
          handoffs: state.handoffs,
          graphCheckpoint: graphResult.checkpoint,
          ...(resumeFromRunId ? { resumeFromRunId } : {}),
        },
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
      output: truncateOuterOutput(resultText),
      meta: {
        runId, agentCallCount: state.agentCallCount, tokensSpent: state.tokensSpent,
        cacheHits: state.cacheHits, phases: state.phases,
        handoffs: state.handoffs,
        graphCheckpoint: graphResult.checkpoint,
        ...(resumeFromRunId ? { resumeFromRunId } : {}),
      },
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
