// ============================================================================
// Subagent Executor - Executes subtasks with limited tool access
// Enhanced with unified pipeline (T4)
// ============================================================================

import { resolveSubagentPreset } from './subagentFirstRunPreset';
import type { ToolCall } from '../../shared/contract';
import { ModelRouter } from '../model/modelRouter';
import { inferenceViaAiSdk, aiSdkSupportsProvider } from '../model/adapters/aiSdkAdapter';
import { createLogger } from '../services/infra/logger';
import { silence } from '../utils/errorHandling';
import { getSubagentPipeline, type ToolExecutionRequest } from './subagentPipeline';
import type { AgentDefinition, DynamicAgentConfig } from './agentDefinition';
import {
  getAgentPrompt,
  getAgentTools,
  getAgentMaxIterations,
  getAgentPermissionPreset,
  getAgentMaxBudget,
} from './agentDefinition';
import { routeExternalSubagentExecution } from './subagentExecutionRouter';
import { compactSubagentMessages } from './subagentCompaction';
import { SUBAGENT_COMPACTION } from '../../shared/constants';
import type { CancellationReason } from '../../shared/contract/cancellation';
import { normalizeCancellationReason } from '../../shared/contract/cancellation';
import {
  AgentFailureCode,
  agentFailureCodeFromCancellationReason,
  inferAgentFailureCode,
} from '../../shared/contract/agentFailure';
import { getPlanApprovalGate } from './planApproval';
import { getSpawnGuard } from './spawnGuard';
import { buildChildContext } from './childContext';
import { AgentTask, type SidecarMetadata } from './agentTask';
import { generateMessageId } from '../../shared/utils/id';
import { getSubagentContextStore } from '../context/subagentContextStore';
import { getConfigService } from '../services/core/configService';
import { applyInterventionsToMessages } from '../context/contextInterventionHelpers';
import { getContextInterventionState } from '../context/contextInterventionState';
import { getTelemetryCollector } from '../telemetry/telemetryCollector';
import {
  buildContextSnapshot,
  buildEffectiveSubagentSystemPrompt,
  buildInferenceMessages,
  buildInitialSubagentMessages,
  buildObservation,
  buildSnapshotAnnotations,
  createRuntimeMessage,
  materializeObservedMessages,
  type RuntimeMessage,
} from './subagentExecutorProjection';
import {
  applySubagentToolExitGate,
  buildSubagentToolTable,
  resolveSubagentToolAccess,
} from './subagentExecutorToolDefs';
import {
  buildSubagentModelCall,
  drainSubagentMessages,
  recordSubagentTelemetryTurn,
  type SubagentTelemetryToolCall,
} from './subagentExecutorTelemetry';
import {
  createSubagentCancellationLifecycle,
  flushSubagentCancellation,
  getChildSubagentExecutionTimeout,
  getSubagentIdleTimeout,
} from './subagentExecutorCancellation';
import { applyRoleBoundaryToSubagentRequest, runRoleWriteBack, recordRoleParticipation } from '../services/roleAssets';
import type {
  SubagentConfig,
  SubagentContext,
  SubagentExecutionContext,
  SubagentExecutionRequest,
  SubagentResult,
} from './subagentExecutorTypes';
import {
  normalizeSubagentExecutionRequest,
  type LegacySubagentContextInput,
} from './subagentExecutorLegacyAdapter';
import { getIncompleteTasks, adoptOrphanTasks } from '../services/planning/taskStore';
import { addSubagentUsage, type SubagentUsage } from './subagentUsageAccounting';
import { runSubagentExecutionWithTrace } from './subagentExecutionTracing';
import { createSubagentToolRuntime } from './subagentToolRuntime';
import {
  normalizeSubagentModelContext,
  resolveSubagentParentContext,
} from './subagentProtocolContext';
import { startSubagentLifecycle } from './subagentLifecycleHooks';
import { SubagentDoomLoopGuard, SubagentDoomLoopStopError } from './subagentDoomLoopGuard';
import { createSubagentTurnObservability, type SubagentRunEndStatus } from './subagentTurnTrace';

export type {
  SubagentConfig,
  SubagentContext,
  SubagentExecutionContext,
  SubagentExecutionRequest,
  SubagentResult,
} from './subagentExecutorTypes';

const logger = createLogger('SubagentExecutor');

// ----------------------------------------------------------------------------
// Types
// ----------------------------------------------------------------------------

// ----------------------------------------------------------------------------
// Subagent Executor
// ----------------------------------------------------------------------------

export class SubagentExecutor {
  private modelRouter: ModelRouter;

  constructor() {
    this.modelRouter = new ModelRouter();
  }

  /**
   * Execute a subagent with a specific prompt and limited tools
   * Now integrates with SubagentPipeline for permission/budget/audit
   */
  async execute(request: SubagentExecutionRequest): Promise<SubagentResult>;
  /** Compatibility overload for tests and non-production callers during migration. */
  async execute(
    prompt: string,
    config: SubagentConfig,
    context: LegacySubagentContextInput,
  ): Promise<SubagentResult>;
  async execute(
    requestOrPrompt: SubagentExecutionRequest | string,
    legacyConfig?: SubagentConfig,
    legacyContext?: LegacySubagentContextInput,
  ): Promise<SubagentResult> {
    const request = applyRoleBoundaryToSubagentRequest(normalizeSubagentExecutionRequest(requestOrPrompt, legacyConfig, legacyContext));
    const externalExecution = routeExternalSubagentExecution(request);
    if (externalExecution) return externalExecution;
    const { prompt, config, context } = request;
    return runSubagentExecutionWithTrace(
      request,
      () => this.executeInternal(prompt, config, context),
    );
  }

  private async executeInternal(
    prompt: string,
    config: SubagentConfig,
    context: SubagentExecutionContext,
  ): Promise<SubagentResult> {
    // ADR-019 批 1：单一防御点——subagent 永不继承父会话的 adaptive 标志。
    // 所有 spawn 路径（Task 工具 / spawn_agent / parallel coordinator）都经过
    // 这里，入口归一化一次覆盖全部，下游 context.modelConfig 引用自动安全。
    context = normalizeSubagentModelContext(context, config.name);

    if (
      process.env.CODE_AGENT_E2E === '1'
      && process.env.CODE_AGENT_E2E_LOCAL_SUBAGENT_EXECUTOR === '1'
    ) {
      const { executeE2ELocalSubagent } = await import('../testing/e2e/subagentE2ELocalExecutor');
      return executeE2ELocalSubagent(prompt, config, context);
    }

    // Create AgentTask for lifecycle tracking
    const agentId = `agent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const taskMetadata: SidecarMetadata = {
      agentType: config.name,
      worktreePath: context.worktreePath,
      parentSessionId: context.sessionId,
      spawnTime: Date.now(),
      model: context.modelConfig.model,
      toolPool: config.availableTools,
    };
    const agentTask = new AgentTask(agentId, taskMetadata);

    const sessionId = startSubagentLifecycle({ agentTask, agentId, prompt, config, context });

    const maxIterations = config.maxIterations || 10;
    const maxToolCalls = config.maxToolCalls !== undefined
      ? Math.max(0, Math.floor(config.maxToolCalls))
      : undefined;
    const toolsUsed: string[] = [];
    // 持久化角色履历用：收集实例产出的产物（设计 §4.3 履历 = 产物清单）
    const instanceArtifacts: Array<{ label: string; ref?: string }> = [];
    let toolCallsAttempted = 0;
    let iterations = 0;
    let finalOutput = '';
    const doomLoopGuard = new SubagentDoomLoopGuard();
    // 跨迭代累加 outputTokens，供 dynamic-workflow 的 BudgetTracker 计费（每次推理后累加）。
    let outputTokensUsed = 0;
    let descendantUsage: SubagentUsage = { cost: 0, tokensUsed: 0 };

    // P3: 计算执行超时时间
    const timeout = getChildSubagentExecutionTimeout(config.name, config.maxExecutionTimeMs, {
      parentStartedAt: context.spawnParentStartedAt,
      parentTimeoutMs: context.spawnParentTimeoutMs,
    });
    const startTime = Date.now();

    const {
      effectiveController,
      effectiveSignal,
      cleanupTimer,
      markProgress,
      markRequestStart,
      markRequestEnd,
      markToolStart,
      markToolEnd,
      stopIdleWatchdog,
    } = createSubagentCancellationLifecycle({
      agentName: config.name,
      timeoutMs: timeout,
      parentSignal: context.abortSignal,
      onIdleNudge: () => doomLoopGuard.queueIdleNudge(),
      onIdleTimeout: (idle) => logger.warn(`[${config.name}] idle ${idle}ms exceeded the active watchdog grade; cancelling`),
    });

    // GAP-011（课程"方向 A"）：skills 全文预注入子代理 system prompt。
    // 持久化角色资产注入（设计 内部文档 §5 步骤 1）。两者只注入知识，不改变
    // availableTools 权限边界；装配细节见 subagentExecutorProjection。
    const effectiveSystemPrompt = await buildEffectiveSubagentSystemPrompt(
      {
        agentName: config.name,
        systemPrompt: config.systemPrompt,
        skills: config.skills,
        roleId: config.roleId,
        cwd: context.cwd,
      },
      logger,
    );

    // Create pipeline context
    const pipeline = getSubagentPipeline();
    const effectivePreset = await resolveSubagentPreset(config.permissionPreset, config.roleId, context.sessionId);
    const dynamicConfig: DynamicAgentConfig = {
      name: config.name,
      systemPrompt: effectiveSystemPrompt,
      tools: config.availableTools,
      maxIterations: config.maxIterations,
      permissionPreset: effectivePreset,
      maxBudget: config.maxBudget,
    };
    const pipelineContext = pipeline.createContext(dynamicConfig, context.cwd, undefined, {
      parentRemainingBudget: context.parentRemainingBudget, executionTopology: context.executionTopology,
    });
    const executionAgentId = context.executionAgentId || context.spawnGuardId || pipelineContext.agentId;
    const executionRunId = context.runId || context.swarmRunScope?.runId || context.traceContext?.runId || agentTask.id;
    const turnObservability = createSubagentTurnObservability({
      sessionId, events: context.events,
      identity: { agentId: executionAgentId, runId: executionRunId, parentToolUseId: context.parentToolUseId },
      workingDirectory: context.worktreePath || context.cwd, warn: (message, error) => logger.warn(`[${config.name}] ${message}`, error),
    });
    const getTotalCost = (): number => {
      const ownCost = pipeline.getBudgetStatus(pipelineContext).subagentCost ?? 0;
      return ownCost + descendantUsage.cost;
    };
    const getTotalTokens = (): number => outputTokensUsed + descendantUsage.tokensUsed;
    const getRemainingTreeBudget = (): number | undefined => {
      const ownRemainingBudget = pipeline.getRemainingBudget(pipelineContext);
      if (ownRemainingBudget === undefined) {
        return undefined;
      }
      return Math.max(0, ownRemainingBudget - descendantUsage.cost);
    };

    // Filter tools to only those allowed for this subagent

    // M2-Task 5 partial: 走 buildChildContext 三档合并算法
    // Compatibility callers may omit the already-projected parent context.
    // Keep the fallback local and policy-free; production protocol callers
    // pass the effective ports and identity explicitly.
    const effectiveParentContext = resolveSubagentParentContext(context);
    if (!context.parentContext) {
      logger.debug(`[${config.name}] parentContext defaulted from explicit execution identity`);
    }

    // 从 settings 读 inheritance 配置（默认 strict-inherit）
    let inheritance: 'strict-inherit' | 'child-narrow' | 'independent' = 'strict-inherit';
    try {
      const cfg = getConfigService().getSettings();
      inheritance = cfg.permissions.inheritance ?? 'strict-inherit';
    } catch {
      // 配置服务未就绪（单测环境）时按默认 strict-inherit 走
    }

    const childCtx = buildChildContext(
      {
        agentType: config.name,
        allowedTools: config.availableTools,
        readOnly: (config.permissionPreset as string) === 'review' || (config.permissionPreset as string) === 'audit',
      },
      effectiveParentContext,
      { inheritance },
    );

    // N-SUBAGENT-ZEROTOOLS：工具面装配（helper 见 subagentExecutorToolDefs）——
    // 父子交集（永不扩张）→ mcp__<server>__* 通配展开（run 策略确定会丢掉的
    // server 不连）→ run 级硬边界收窄 → 注册表解析。装配只产生候选与账目。
    // 返修 Important 1：装配等待接入 effectiveSignal（父 abort + 内部 timeout 桥接），
    // 取消后不再傻等连接 / 不再发起后续服务器连接。
    const assembly = await resolveSubagentToolAccess(
      config,
      context,
      effectiveParentContext,
      childCtx,
      { signal: effectiveSignal },
    );

    // N-SUBAGENT-ZEROTOOLS R5 出口闸：「谁能进模型工具表」唯一裁定点。全部约束
    // （run 策略重放、角色硬边界——含 disallowExternalSending，对通配展开后的
    // 具体名重判、fail-loud 判定）集中在这里应用一次；装配链不管中间经历几次
    // 展开/过滤，产物到模型只有这一条路（buildSubagentToolTable 只收闸产物）。
    const surface = applySubagentToolExitGate(assembly, {
      runPolicy: {
        allowedToolNames: context.allowedToolNames,
        deniedToolNames: context.deniedToolNames,
        toolScope: context.toolScope,
      },
      roleId: config.roleId,
      signal: effectiveSignal,
    });

    logger.info(`[${config.name}] childContext applied`, {
      inheritance,
      parentTools: effectiveParentContext.availableTools.length,
      childDeclared: config.availableTools.length,
      toolPool: assembly.effectiveToolNames.length,
      exitGateKept: surface.toolNames.length,
      denyMerged: childCtx.permissions.deny.length,
      effectiveMode: childCtx.permissions.effectiveMode,
      explicitParent: !!context.parentContext,
    });

    const allowedNames = new Set(surface.toolNames);

    // P0(G18): 把 buildChildContext 算出的父→子收缩结果真正应用到 pipeline 的
    // permissionConfig。此前 childCtx.permissions 只被 log、从未生效，导致
    // checkToolExecution（subagentPolicy 收缩闸）跑的是未收缩的子 preset。
    // 父级 blockedCommands 合并进来 → 子 agent 不能执行父 agent 禁的命令。
    if (childCtx.permissions.blockedCommands?.length) {
      pipelineContext.permissionConfig = {
        ...pipelineContext.permissionConfig,
        blockedCommands: [...new Set([
          ...pipelineContext.permissionConfig.blockedCommands,
          ...childCtx.permissions.blockedCommands,
        ])],
      };
    }
    // 收缩后的有效 mode（buildChildContext 已取父子较严者，canEscalate 恒 false）
    const subagentEffectiveMode = childCtx.permissions.effectiveMode;

    // P0(G5): subagent 工具调用统一收口到 ToolExecutor —— 与主 agent 同一条
    // 权限/校验/审计/缓存管道，不再走 ProtocolToolResolver.execute 旁路。
    // subagent 的"不同策略"通过 subagentPolicy 表达：工具白名单 + checkToolExecution 收缩闸。
    const toolRuntime = createSubagentToolRuntime({
      context,
      sessionId,
      effectiveMode: subagentEffectiveMode,
      identity: turnObservability.identity,
      allowedToolNames: allowedNames,
      checkToolExecution: (request) => pipeline.checkToolExecution(pipelineContext, request).allowed,
    });
    const subagentToolExecutor = toolRuntime.executor;
    const subagentPolicy = toolRuntime.policy;

    // 模型工具表投影（supportsTool 判定 + inference 入参映射）：helper 见 subagentExecutorToolDefs
    const { toolDefinitions, supportsTool } = buildSubagentToolTable(config.name, context.modelConfig, surface);

    const subagentContextStore = getSubagentContextStore();
    // Parallel/Team callers provide a stable composite execution identity.
    // Keep the pipeline's internal random id private to the pipeline registry;
    // user-facing events, tool calls, approvals and results must stay in the
    // caller's run scope.
    const telemetryCollector = context.telemetryCollector ?? getTelemetryCollector();
    let telemetryTurnNumber = 0;

    const messages = buildInitialSubagentMessages({
      agentName: config.name,
      systemPrompt: effectiveSystemPrompt,
      prompt,
      attachments: context.attachments,
      logger,
    });
    let latestContextSnapshot = buildContextSnapshot(
      messages,
      context.modelConfig.model,
      context.modelConfig.provider,
      toolsUsed,
      context.attachments,
    );
    const emitContextSnapshot = (messageOverride?: RuntimeMessage[]): void => {
      const effectiveMessages = messageOverride || messages;
      latestContextSnapshot = buildContextSnapshot(
        effectiveMessages,
        context.modelConfig.model,
        context.modelConfig.provider,
        toolsUsed,
        context.attachments,
      );
      context.onContextSnapshot?.(latestContextSnapshot);
      const annotations = buildSnapshotAnnotations(effectiveMessages, executionAgentId);
      subagentContextStore.upsert({
        sessionId,
        agentId: executionAgentId,
        messages: materializeObservedMessages(effectiveMessages),
        snapshot: latestContextSnapshot,
        annotations,
        maxTokens: latestContextSnapshot.maxTokens,
        updatedAt: Date.now(),
      });
    };
    const pushObservabilityMessage = (_message: unknown): void => {};
    emitContextSnapshot();

    logger.info(`[${config.name}] Starting with ${toolDefinitions.length} tools (agentId: ${pipelineContext.agentId}, supportsTool: ${supportsTool})`);

    // 发射 subagent 初始化事件
    const parentToolUseId = context.parentToolUseId;
    if (parentToolUseId) {
      context.events.emit('agent_thinking', {
        message: `Subagent [${config.name}] starting...`,
        agentId: executionAgentId,
        parentToolUseId,
      });
    }

    let terminalStatus: SubagentRunEndStatus = 'failed'; let terminalError: string | undefined;

    // 早退失败收口（预算触顶 / 工具装配失败共用）：统一 cleanup + orphan 接管 +
    // SubagentStop + 结构化失败返回，extra 携带各自的 failureCode/缺失清单等差异化字段。
    const earlyFailure = (error: string, extra: Partial<SubagentResult>): SubagentResult => {
      logger.error(`[${config.name}] ${error}`);
      cleanupTimer();
      stopIdleWatchdog();
      terminalError = error;
      pipeline.completeContext(pipelineContext.agentId, false, error);
      agentTask.fail(error);
      // orphan 接管（roadmap 2.6）：subagent 名下未收口任务释放回主会话
      adoptOrphanTasks(sessionId, pipelineContext.agentId);
      context.hooks?.triggerSubagentStop(config.name, undefined, sessionId, agentTask.id)
        .catch(silence(logger, 'triggerSubagentStop:early-failure', 'warn'));
      return {
        success: false,
        output: '',
        error,
        toolsUsed: [],
        iterations: 0,
        tokensUsed: getTotalTokens(),
        cost: getTotalCost(),
        agentId: executionAgentId,
        contextSnapshot: latestContextSnapshot,
        ...extra,
      };
    };

    try {
      // Initial budget check
      const budgetCheck = pipeline.checkBudget(pipelineContext);
      if (!budgetCheck.allowed) {
        // swarm 护栏 P1-2 #1：子代理触顶自身预算 → 结构化失败码，
        // 编排层 routeFailureCode 据此降级（'degrade'）而非 parse error 字符串。
        return earlyFailure(budgetCheck.reason || 'Budget exceeded', {
          cancellationReason: 'child-max-tokens',
          failureCode: AgentFailureCode.BudgetExhausted,
        });
      }

      // N-SUBAGENT-ZEROTOOLS ①（R5 收口进出口闸）：声明了工具（请求集非空）但出口
      // 闸后工具表为空 ⇒ fail-loud，不许静默跑一个无工具可用的子代理、再拿一句敷衍
      // 输出回报 completed。判据在闸里集中应用（见 applySubagentToolExitGate）：
      // 刻意不是「0 工具」（纯推理/纯总结角色声明 0 工具合法），也不是 supportsTool=false
      //（那是模型能力问题，上方已有独立 warn）；取消打断让位 abort 收口；R4 的
      // 失败账臂（声明通配 + 白名单精确名形态不匹配）同样在闸里裁定。
      // 部分缺失（声明 5 拿到 2）不在此失败，missingTools 随结果带回父模型自行裁量。
      if (surface.assemblyFailure) {
        const { missingTools } = surface.assemblyFailure;
        return earlyFailure(
          `声明的 ${missingTools.length} 个工具全部未装配（白名单收窄 + 注册表解析后为 0）：` +
          `${missingTools.join(', ')}。子代理未执行任何迭代即失败：` +
          `请修正工具名，或确认对应 MCP 服务器可连接后重试。`,
          {
            failureCode: AgentFailureCode.ToolUnavailable,
            missingTools: [...missingTools],
          },
        );
      }

      // subagent taskGate（roadmap 2.6，衔接 1.3）：想收口但名下还有未收口任务时
      // 注入重入消息督办，上限 2 次（MiMo subagent 上限），防跑飞
      let taskGateReentries = 0;
      const SUBAGENT_TASK_GATE_MAX_REENTRIES = 2;

      while (iterations < maxIterations) {
        iterations++;
        logger.info(`[${config.name}] Iteration ${iterations}`);

        // 孤儿回收（swarm 护栏 P1-2 #5）：后台 detached 子代理每轮探活，父 run 已结束/
        // 被新 run 取代时用 parent-gone 中止，避免成孤儿继续烧预算。abort 后立即落到
        // 下方现有 abort 路径（normalize 'parent-gone' 已知 → 落盘部分产物后返回）。
        if (
          context.isParentAlive &&
          !effectiveSignal.aborted &&
          !context.isParentAlive()
        ) {
          logger.warn(`[${config.name}] Parent run gone — reaping orphan subagent (parent-gone)`);
          effectiveController.abort('parent-gone');
        }

        // Check abort signal (covers both external cancel and timeout).
        // Wires the four-phase shutdownProtocol (Signal→Grace→Flush→Force)
        // so that partial transcript + metadata get persisted via
        // AgentTask.saveToDisk before we return failure.
        if (effectiveSignal.aborted) {
          const rawReason: unknown = effectiveSignal.reason;
          const cancellationReason: CancellationReason =
            rawReason === 'timeout'
              ? 'timeout'
              : rawReason === 'idle-timeout'
                ? 'idle-timeout'
                : normalizeCancellationReason(rawReason, 'parent-cancel');

          logger.info(
            `[${config.name}] Execution aborted reason=${cancellationReason} after ${Date.now() - startTime}ms`,
          );
          cleanupTimer();
          stopIdleWatchdog();

          // Phase 3 flush — persist partial transcript + metadata.
          // R5（grace 不等自己）/ sessionDir 约定 / patch 抢救的细节在 helper 里。
          await flushSubagentCancellation({
            agentName: config.name,
            agentTask,
            controller: effectiveController,
            sessionId,
            worktreePath: context.worktreePath,
            cwd: context.cwd,
            logger,
          });

          pipeline.completeContext(pipelineContext.agentId, false, cancellationReason);
          const errorMsg = cancellationReason === 'timeout'
            ? `执行超时 (${Math.round(timeout / 1000)}秒)，已完成 ${iterations} 次迭代`
            : cancellationReason === 'idle-timeout'
              ? `子代理 ${Math.round(getSubagentIdleTimeout(timeout) / 1000)}s 无 stream/progress, 已自动取消 (idle-timeout)`
              : `任务已取消 (${cancellationReason})`;
          terminalStatus = 'cancelled';
          terminalError = errorMsg;
          agentTask.fail(errorMsg);
          // orphan 接管（roadmap 2.6）
          adoptOrphanTasks(sessionId, pipelineContext.agentId);
          if (context.spawnGuardId) {
            getSpawnGuard().cancelDescendants(context.spawnGuardId, 'parent-cancel');
          }
          // Fire SubagentStop on abort/timeout
          context.hooks?.triggerSubagentStop(config.name, undefined, sessionId, agentTask.id).catch(silence(logger, 'triggerSubagentStop:abort', 'warn'));
          return {
            success: false,
            output: finalOutput || '',
            error: errorMsg,
            toolsUsed: [...new Set(toolsUsed)],
            iterations,
            tokensUsed: getTotalTokens(),
            cost: getTotalCost(),
            agentId: executionAgentId,
            contextSnapshot: latestContextSnapshot,
            cancellationReason,
            failureCode: agentFailureCodeFromCancellationReason(cancellationReason)
              ?? inferAgentFailureCode({ error: errorMsg }),
          };
        }

        // Drain structured message queue (mid-loop injection)
        {
          const externalMessages = context.messageDrain ? await context.messageDrain() : [];
          const pendingMessages = [
            ...(context.spawnGuardId ? getSpawnGuard().drainMessages(context.spawnGuardId) : []),
            ...externalMessages,
          ];
          const injected = drainSubagentMessages({
            agentName: config.name,
            messages,
            pendingMessages,
            logger,
            pushObservabilityMessage,
          });
          if (injected > 0) {
            emitContextSnapshot();
          }
          if (externalMessages.length > 0) {
            await context.ackMessageDrain?.();
          }
        }

        // Check budget before each iteration
        const iterBudgetCheck = pipeline.checkBudget(pipelineContext);
        if (!iterBudgetCheck.allowed) {
          logger.warn(`[${config.name}] Budget exceeded at iteration ${iterations}`);
          break;
        }

        const telemetryTurnId = turnObservability.startTurn(iterations);
        // Auto-compaction: truncate old messages if approaching context limit
        if (iterations > SUBAGENT_COMPACTION.SKIP_FIRST_ITERATIONS) {
          if (compactSubagentMessages(messages, context.modelConfig.model, context.modelConfig.provider)) {
            turnObservability.recordCompaction(latestContextSnapshot.currentTokens);
            for (const message of messages) {
              if (typeof message.content === 'string' && message.content.includes('[truncated]')) {
                message.observation = buildObservation('compression_survivor', 'subagent_compaction', {
                  sourceKind: 'compression_survivor',
                  layer: 'subagent_compaction',
                });
              }
            }
            emitContextSnapshot();
          }
        }

        // Call model
        const effectiveInterventions = getContextInterventionState().getEffectiveSnapshot(
          sessionId,
          executionAgentId,
        );
        const inferenceMessages = applyInterventionsToMessages(messages, effectiveInterventions);
        const providerMessages = buildInferenceMessages(inferenceMessages);
        const telemetryTurnStartedAt = Date.now();
        const currentTelemetryTurnNumber = ++telemetryTurnNumber;
        const telemetryToolCalls: SubagentTelemetryToolCall[] = [];

        try {
        const inferenceStartedAt = Date.now();
        // effectiveSignal 把父 abort + 内部 timeout 都桥接进来；
        // 不传给 inference 的话，父 abort 后这一轮 LLM call 还会跑完才被循环开头 check 拦截，
        // 期间继续烧 token + 子 agent 拖慢退出。
        // Provider 迁移：子代理默认走 AI SDK 适配器（用 SDK 归一 provider 工具调用，修 Bug B：
        // DeepSeek 非流式漏 DSML / 子代理拿不到工具）。CODE_AGENT_MODEL_ENGINE=legacy 一键回退旧
        // modelRouter 路径。适配器不支持的 provider（gemini 原生 API）即便默认 aisdk 也自动留在旧
        // 路径（见 aiSdkSupportsProvider），不引入回归。
        // 注意：AI SDK 适配器吃【压平前】的 inferenceMessages（保留 role:'tool'+toolResults
        // 配对），不能用 buildInferenceMessages 压平后的 providerMessages（它把 tool 结果变成
        // user 消息，导致 AI SDK 报 "Tool result is missing"）。
        const useAiSdk = process.env.CODE_AGENT_MODEL_ENGINE !== 'legacy'
          && aiSdkSupportsProvider(context.modelConfig.provider, context.modelConfig.model);
        // per-request 超时取执行预算的一半：单次 provider 卡住（接受连接但响应不返回）时在 ~budget/2 早退 +
        // withTransientRetry 重试（重发常能过），而非把整个子代理预算耗在一次挂死上——旧 AI SDK 路径无
        // per-request 超时，一次 stall = 整个子代理跑满 90s 硬超时报废（实测 zhipu glm-4-flash 偶发）。
        const subagentRequestTimeoutMs = Math.floor(timeout / 2);
        // 请求在途期间不判 idle：子代理非流式，一次大上下文调用可以远超 idle 阈值
        // （实测 GLM-5 >120s），在途请求另有 per-request 超时 + 总预算兜底。
        markRequestStart();
        const response = await (useAiSdk
          ? inferenceViaAiSdk(inferenceMessages as unknown as Parameters<typeof inferenceViaAiSdk>[0], toolDefinitions, context.modelConfig, undefined, effectiveSignal, { requestTimeoutMs: subagentRequestTimeoutMs })
          : this.modelRouter.inference(
              providerMessages,
              toolDefinitions,
              context.modelConfig,
              () => {}, // No streaming for subagents
              effectiveSignal,
            )
        ).finally(markRequestEnd);
        const inferenceDuration = Date.now() - inferenceStartedAt;
        markProgress();

        const modelCall = buildSubagentModelCall({
          response,
          providerMessages,
          modelConfig: context.modelConfig,
          inferenceDuration,
          telemetryTurnId,
          turnNumber: currentTelemetryTurnNumber,
        });
        outputTokensUsed += modelCall.outputTokens;
        pipeline.recordTokenUsage(pipelineContext, {
          inputTokens: modelCall.inputTokens,
          outputTokens: modelCall.outputTokens,
          model: context.modelConfig.model,
          provider: context.modelConfig.provider,
          timestamp: Date.now(),
          sessionId,
        });

        const persistTelemetryTurn = (assistantResponse: string, thinking?: string): void => {
          recordSubagentTelemetryTurn(telemetryCollector, {
            sessionId,
            turnId: telemetryTurnId,
            turnNumber: currentTelemetryTurnNumber,
            prompt,
            assistantResponse,
            thinking,
            agentId: executionAgentId,
            parentTurnId: context.parentToolUseId,
            startTime: telemetryTurnStartedAt,
            modelCall,
            toolCalls: telemetryToolCalls,
            toolDefinitions,
          });
        };

        if (doomLoopGuard.handleEmptyOutput(response, messages, emitContextSnapshot, persistTelemetryTurn)) continue;

        // Handle text response - subagent is done
        if (response.type === 'text' && response.content) {
          // taskGate（roadmap 2.6）：收口前检查名下未收口任务，重入督办（上限 2）
          const ownedOpenTasks = getIncompleteTasks(sessionId).filter(
            (t) => t.owner === pipelineContext.agentId,
          );
          if (ownedOpenTasks.length > 0 && taskGateReentries < SUBAGENT_TASK_GATE_MAX_REENTRIES) {
            taskGateReentries++;
            const taskLines = ownedOpenTasks.map((t) => `- #${t.id} [${t.status}] ${t.subject}`).join('\n');
            logger.info(`[${config.name}] taskGate re-entry ${taskGateReentries}/${SUBAGENT_TASK_GATE_MAX_REENTRIES}: ${ownedOpenTasks.length} open task(s)`);
            messages.push(createRuntimeMessage({
              role: 'user',
              content:
                `[taskGate] 你名下还有 ${ownedOpenTasks.length} 个未收口任务：\n${taskLines}\n` +
                `请先用 TaskManager 把它们置为 completed（已完成）或 cancelled（说明原因），再给出最终总结。`,
            }));
            continue;
          }
          finalOutput = response.content;
          messages.push(createRuntimeMessage({
            role: 'assistant',
            content: response.content,
            observation: buildObservation('recent_turn', 'assistant_response', {
              sourceKind: 'message',
              layer: 'assistant_turn',
            }),
          }));
          pushObservabilityMessage({
            id: generateMessageId(),
            role: 'assistant',
            content: response.content,
            timestamp: Date.now(),
          });
          emitContextSnapshot();
          persistTelemetryTurn(response.content, response.thinking);
          break;
        }

        // Handle tool calls
        if (response.type === 'tool_use' && response.toolCalls) {
          doomLoopGuard.recordStep(response.toolCalls);

          const toolResults: string[] = [];
          const assistantToolCalls: ToolCall[] = response.toolCalls.map((toolCall) => ({
            id: toolCall.id,
            name: toolCall.name,
            arguments: toolCall.arguments,
          }));
          pushObservabilityMessage({
            id: generateMessageId(),
            role: 'assistant',
            content: response.toolCalls
              .map((tc) => `Calling ${tc.name}(${JSON.stringify(tc.arguments)})`)
              .join('\n'),
            toolCalls: assistantToolCalls,
            timestamp: Date.now(),
          });

          for (const [toolIndex, toolCall] of response.toolCalls.entries()) {
            if (maxToolCalls !== undefined && toolCallsAttempted >= maxToolCalls) {
              const error = `Tool call blocked by tool policy: maxToolCalls=${maxToolCalls}, attempted ${toolCall.name}`;
              logger.warn(`[${config.name}] ${error}`);
              throw new Error(error);
            }
            toolCallsAttempted += 1;

            const toolDef = allowedNames.has(toolCall.name)
              ? context.resolver.getDefinition(toolCall.name)
              : undefined;
            if (!toolDef) {
              const error = `Tool ${toolCall.name} not available`;
              toolResults.push(`Error: ${error}`);
              telemetryToolCalls.push({
                toolCallId: toolCall.id,
                name: toolCall.name,
                arguments: toolCall.arguments,
                success: false,
                error,
                durationMs: 0,
                timestamp: Date.now(),
                index: toolIndex,
              });
              pushObservabilityMessage({
                id: generateMessageId(),
                role: 'tool',
                content: `Error: ${error}`,
                toolResults: [{
                  toolCallId: toolCall.id,
                  success: false,
                  error,
                }],
                timestamp: Date.now(),
              });
              continue;
            }

            // Build tool execution request for pipeline
            const toolRequest: ToolExecutionRequest = {
              toolName: toolCall.name,
              permissionLevel: toolDef.permissionLevel,
              path: toolCall.arguments.path as string | undefined
                || toolCall.arguments.file_path as string | undefined,
              command: toolCall.arguments.command as string | undefined,
              url: toolCall.arguments.url as string | undefined,
            };

            // Budget pre-gate（权限检查已收口到 ToolExecutor 的 subagentPolicy，见下方 execute 调用）
            const permCheck = pipeline.checkBudget(pipelineContext);
            if (!permCheck.allowed) {
              const error = `Budget exceeded for ${toolCall.name}: ${permCheck.reason}`;
              toolResults.push(`Error: ${error}`);
              logger.warn(`[${config.name}] Tool ${toolCall.name} blocked: ${permCheck.reason}`);
              telemetryToolCalls.push({
                toolCallId: toolCall.id,
                name: toolCall.name,
                arguments: toolCall.arguments,
                success: false,
                error,
                durationMs: 0,
                timestamp: Date.now(),
                index: toolIndex,
                metadata: { permissionTrace: 'budget_exceeded', reason: permCheck.reason },
              });
              pushObservabilityMessage({
                id: generateMessageId(),
                role: 'tool',
                content: `Error: ${error}`,
                toolResults: [{
                  toolCallId: toolCall.id,
                  success: false,
                  error,
                }],
                timestamp: Date.now(),
              });
              continue;
            }

            // Log warnings
            for (const warning of permCheck.warnings) {
              logger.warn(`[${config.name}] Tool warning: ${warning}`);
            }

            // Plan approval gate for high-risk operations
            if (config.requirePlanApproval) {
              const gate = getPlanApprovalGate();
              const risk = gate.assessRisk(toolRequest, context.cwd);
              if (risk.level !== 'low') {
                const approval = await gate.submitForApproval({
                  agentId: executionAgentId,
                  agentName: config.name,
                  coordinatorId: config.coordinatorId || 'coordinator',
                  plan: `Tool: ${toolCall.name}\nArgs: ${JSON.stringify(toolCall.arguments)}\nRisk: ${risk.reasons.join(', ')}`,
                  risk,
                  scope: context.swarmRunScope,
                  signal: effectiveSignal,
                });
                if (effectiveSignal.aborted) {
                  throw new Error(
                    `Task cancelled after plan approval (${String(effectiveSignal.reason ?? 'parent-cancel')})`,
                  );
                }
                if (!approval.approved) {
                  const error = `Blocked by plan approval: ${approval.feedback || 'rejected'}`;
                  toolResults.push(`Tool ${toolCall.name}: ${error}`);
                  logger.info(`[${config.name}] Tool ${toolCall.name} blocked by plan approval`);
                  telemetryToolCalls.push({
                    toolCallId: toolCall.id,
                    name: toolCall.name,
                    arguments: toolCall.arguments,
                    success: false,
                    error,
                    durationMs: 0,
                    timestamp: Date.now(),
                    index: toolIndex,
                    metadata: { permissionTrace: 'plan_approval_denied', risk },
                  });
                  pushObservabilityMessage({
                    id: generateMessageId(),
                    role: 'tool',
                    content: `Tool ${toolCall.name}: ${error}`,
                    toolResults: [{
                      toolCallId: toolCall.id,
                      success: false,
                      error,
                    }],
                    timestamp: Date.now(),
                  });
                  continue;
                }
              }
            }

            toolsUsed.push(toolCall.name);
            pipeline.recordToolUsage(pipelineContext, toolCall.name);
            logger.info(`[${config.name}] Executing tool: ${toolCall.name}`);

            // 发射 subagent 工具调用开始事件
            turnObservability.emitToolCallStart(toolCall);

            const toolStartTime = Date.now();
            const workspaceMutationSnapshot = await turnObservability.beginTool(toolCall.name);
            markToolStart();
            try {
              const result = await subagentToolExecutor.execute(
                toolCall.name,
                toolCall.arguments,
                {
                  runId: executionRunId,
                  sessionId: context.sessionId,
                  sourceMessageId: context.sourceMessageId,
                  agentId: executionAgentId,
                  spawnDepth: context.spawnDepth,
                  spawnMaxDepth: context.spawnMaxDepth,
                  spawnTreeId: context.spawnTreeId,
                  swarmRunScope: context.swarmRunScope,
                  spawnQueueTimeoutMs: context.spawnQueueTimeoutMs,
                  spawnParentStartedAt: startTime,
                  spawnParentTimeoutMs: timeout,
                  parentRemainingBudget: getRemainingTreeBudget(),
                  spawnParentAgentId: context.spawnGuardId,
                  // 持久化角色 ID → 透传给工具层（MemoryWrite/Read scope='role' 路由用）
                  agentRole: config.roleId,
                  hookManager: context.hooks as import('../hooks/hookManager').HookManager | undefined,
                  abortSignal: effectiveSignal,
                  currentToolCallId: toolCall.id,
                  toolScope: context.toolScope,
                  // Run 级工具面沿 spawn 链传递：孙代理 spawn 时同样只能收窄
                  deniedToolNames: context.deniedToolNames,
                  allowedToolNames: context.allowedToolNames,
                  emitEvent: context.events.emit,
                  modelConfig: context.modelConfig,
                  subagentPolicy,
                },
              ).finally(markToolEnd);
              descendantUsage = addSubagentUsage(descendantUsage, result.metadata);
              const toolDuration = Date.now() - toolStartTime;
              toolResults.push(
                `Tool ${toolCall.name}: ${result.success ? 'Success' : 'Failed'}\n${result.output || result.error || ''}`
              );
              // 持久化角色履历：从工具结果里收集产物引用
              if (config.roleId && result.success && result.metadata && typeof result.metadata === 'object') {
                const artifact = (result.metadata as { artifact?: { name?: string; path?: string; id?: string } }).artifact;
                if (artifact && (artifact.name || artifact.path)) {
                  instanceArtifacts.push({
                    label: artifact.name || artifact.path || toolCall.name,
                    ref: artifact.id ? `artifact://${artifact.id}` : artifact.path,
                  });
                }
              }
              telemetryToolCalls.push({
                toolCallId: toolCall.id,
                name: toolCall.name,
                arguments: toolCall.arguments,
                resultSummary: result.output || result.error,
                success: result.success,
                error: result.error,
                durationMs: toolDuration,
                timestamp: toolStartTime,
                index: toolIndex,
                metadata: result.metadata,
              });
              pushObservabilityMessage({
                id: generateMessageId(),
                role: 'tool',
                content: result.output || result.error || '',
                toolResults: [{
                  toolCallId: toolCall.id,
                  success: result.success,
                  output: result.output,
                  error: result.error,
                  duration: toolDuration,
                  outputPath: result.outputPath,
                  metadata: result.metadata,
                }],
                timestamp: Date.now(),
              });

              // 发射 subagent 工具调用结束事件
              await turnObservability.recordToolResult(toolCall, result, toolDuration, workspaceMutationSnapshot);
            } catch (error) {
              const toolDuration = Date.now() - toolStartTime;
              const errorMessage = error instanceof Error ? error.message : 'Unknown error';
              toolResults.push(
                `Tool ${toolCall.name}: Error - ${errorMessage}`
              );
              telemetryToolCalls.push({
                toolCallId: toolCall.id,
                name: toolCall.name,
                arguments: toolCall.arguments,
                success: false,
                error: errorMessage,
                durationMs: toolDuration,
                timestamp: toolStartTime,
                index: toolIndex,
              });
              pushObservabilityMessage({
                id: generateMessageId(),
                role: 'tool',
                content: errorMessage,
                toolResults: [{
                  toolCallId: toolCall.id,
                  success: false,
                  error: errorMessage,
                  duration: toolDuration,
                }],
                timestamp: Date.now(),
              });

              // 发射 subagent 工具调用错误事件
              turnObservability.recordToolError(toolCall, errorMessage, toolDuration);
            }
          }

          // Add tool results to messages
          messages.push(createRuntimeMessage({
            role: 'assistant',
            content: response.toolCalls
              .map((tc) => `Calling ${tc.name}(${JSON.stringify(tc.arguments)})`)
              .join('\n'),
            toolCalls: assistantToolCalls,
            observation: buildObservation(
              'tool_result',
              assistantToolCalls.map((toolCall) => toolCall.name).join(', '),
              {
                sourceKind: 'tool_result',
                layer: 'assistant_tool_call',
              },
            ),
          }));
          messages.push(createRuntimeMessage({
            role: 'user',
            content: `Tool results:\n${toolResults.join('\n\n')}`,
            observation: buildObservation(
              'tool_result',
              response.toolCalls.map((toolCall) => toolCall.name).join(', '),
              {
                sourceKind: 'tool_result',
                layer: 'tool_result_summary',
              },
            ),
          }));
          doomLoopGuard.injectPendingNudge(messages);
          pushObservabilityMessage({
            id: generateMessageId(),
            role: 'user',
            content: `Tool results:\n${toolResults.join('\n\n')}`,
            timestamp: Date.now(),
          });
          emitContextSnapshot();
          persistTelemetryTurn(
            response.toolCalls
              .map((tc) => `Calling ${tc.name}(${JSON.stringify(tc.arguments)})`)
              .join('\n'),
            response.thinking,
          );

          continue;
        }

        // No response, break
        break;
        } finally {
          await turnObservability.endTurn(telemetryTurnId);
        }
      }

      // Get final cost
      cleanupTimer();
      stopIdleWatchdog();
      pipeline.completeContext(pipelineContext.agentId, true);

      // Record final output in transcript and close AgentTask lifecycle
      agentTask.appendTranscript({
        role: 'assistant',
        content: finalOutput || 'Subagent completed without output',
        timestamp: Date.now(),
      });
      agentTask.stop();

      // orphan 接管（roadmap 2.6）：正常结束时名下未收口任务回归主会话
      adoptOrphanTasks(sessionId, pipelineContext.agentId);
      if (context.spawnGuardId) {
        getSpawnGuard().cancelDescendants(context.spawnGuardId, 'parent-gone');
      }

      // Fire SubagentStop hook (fire-and-forget)
      // GAP-012: 带上 agentId 作为 swarm trace 查询入口
      if (context.hooks) {
        context.hooks.triggerSubagentStop(
          config.name,
          finalOutput || undefined,
          sessionId,
          agentTask.id,
        ).catch(() => {});
      }

      // 持久化角色写回（设计 §5 步骤 3，fire-and-forget）：
      // 实例正常结束 → quick model 判断值得记的知识 → write gate → 落盘 + 履历。
      // 非持久角色在 runRoleWriteBack 内部零成本跳过；失败只记日志，绝不影响实例返回。
      if (config.roleId && finalOutput) {
        runRoleWriteBack({
          roleId: config.roleId,
          workspacePath: context.cwd,
          taskPrompt: prompt,
          finalOutput,
          artifacts: instanceArtifacts,
        }).catch(silence(logger, 'runRoleWriteBack', 'warn'));

        // 角色参与记录：主 run 结束后据此触发 event 醒来（内部文档 §2.2）
        recordRoleParticipation(sessionId, config.roleId);
      }

      terminalStatus = 'completed';
      return {
        success: true,
        output: finalOutput || 'Subagent completed without output',
        toolsUsed: [...new Set(toolsUsed)],
        iterations,
        tokensUsed: getTotalTokens(),
        cost: getTotalCost(),
          agentId: executionAgentId,
        contextSnapshot: latestContextSnapshot,
        // N-SUBAGENT-ZEROTOOLS：部分声明的工具没装配上时不失败，但清单必须带回
        // 父模型（由调用方透传），让父模型自行裁量这结果可信到什么程度。
        ...(surface.missingToolNames.length > 0 ? { missingTools: [...surface.missingToolNames] } : {}),
      };
    } catch (error) {
      if (effectiveSignal.aborted || error instanceof SubagentDoomLoopStopError) {
        terminalStatus = 'cancelled';
      }
      terminalError = error instanceof Error ? error.message : String(error);
      cleanupTimer();
      stopIdleWatchdog();
      pipeline.completeContext(
        pipelineContext.agentId,
        false,
        error instanceof Error ? error.message : 'Unknown error'
      );

      agentTask.fail(error instanceof Error ? error.message : String(error));

      // orphan 接管（roadmap 2.6）
      adoptOrphanTasks(sessionId, pipelineContext.agentId);
      if (context.spawnGuardId) {
        getSpawnGuard().cancelDescendants(context.spawnGuardId, 'parent-cancel');
      }

      // Fire SubagentStop hook on failure (fire-and-forget)
      // GAP-012: 带上 agentId 作为 swarm trace 查询入口
      if (context.hooks) {
        context.hooks.triggerSubagentStop(
          config.name,
          undefined,
          sessionId,
          agentTask.id,
        ).catch(() => {});
      }

      if (error instanceof SubagentDoomLoopStopError) return error.toResult(finalOutput, toolsUsed, iterations, getTotalTokens(), getTotalCost(), executionAgentId, latestContextSnapshot);

      // 把已消耗的 outputTokens 挂到 error 上，让 dynamic-workflow 的 BudgetTracker 在抛出路径
      // 也能记账（provider 产出部分 output 后崩的场景，Codex R2 MED#4）。不影响既有错误处理。
      if (error && typeof error === 'object') {
        try {
          (error as { tokensUsed?: number; cost?: number }).tokensUsed = getTotalTokens();
          (error as { tokensUsed?: number; cost?: number }).cost = getTotalCost();
        } catch { /* frozen error, ignore */ }
      }
      throw error; // re-throw to preserve existing error handling
    } finally {
      turnObservability.endRun(terminalStatus, terminalError);
    }
  }

  /**
   * Execute from an AgentDefinition (declarative mode)
   */
  async executeFromDefinition(
    prompt: string,
    agentDef: AgentDefinition,
    context: SubagentContext
  ): Promise<SubagentResult> {
    // Convert AgentDefinition to SubagentConfig using helper functions
    const config: SubagentConfig = {
      name: agentDef.name,
      // 持久化角色资产绑定 key（agent 注册 id）
      roleId: agentDef.id,
      systemPrompt: getAgentPrompt(agentDef),
      availableTools: getAgentTools(agentDef),
      // GAP-011：agent 定义里的预装 skills（方向 A）
      skills: agentDef.skills,
      maxIterations: getAgentMaxIterations(agentDef),
      permissionPreset: getAgentPermissionPreset(agentDef),
      maxBudget: getAgentMaxBudget(agentDef),
    };

    return this.execute({ prompt, config, context });
  }
}

// Singleton instance
let subagentExecutor: SubagentExecutor | null = null;

export function getSubagentExecutor(): SubagentExecutor {
  if (!subagentExecutor) {
    subagentExecutor = new SubagentExecutor();
  }
  return subagentExecutor;
}
