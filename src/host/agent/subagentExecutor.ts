// ============================================================================
// Subagent Executor - Executes subtasks with limited tool access
// Enhanced with unified pipeline (T4)
// ============================================================================

import type { ToolCall } from '../../shared/contract';
import type { ToolContext } from '../tools/types';
import { ToolExecutor } from '../tools/toolExecutor';
import { createRunContext } from '../runtime/runContext';
import { ModelRouter } from '../model/modelRouter';
import { inferenceViaAiSdk, aiSdkSupportsProvider } from '../model/adapters/aiSdkAdapter';
import { createLogger } from '../services/infra/logger';
import { silence } from '../utils/errorHandling';
import {
  getSubagentPipeline,
  type ToolExecutionRequest,
} from './subagentPipeline';
import type { AgentDefinition, DynamicAgentConfig } from './agentDefinition';
import {
  getAgentPrompt,
  getAgentTools,
  getAgentMaxIterations,
  getAgentPermissionPreset,
  getAgentMaxBudget,
} from './agentDefinition';
import { PROVIDER_REGISTRY } from '../model/modelRouter';
import { compactSubagentMessages } from './subagentCompaction';
import { SUBAGENT_COMPACTION } from '../../shared/constants';
import { initiateShutdown } from './shutdownProtocol';
import type { CancellationReason } from '../../shared/contract/cancellation';
import { normalizeCancellationReason } from '../../shared/contract/cancellation';
import {
  AgentFailureCode,
  agentFailureCodeFromCancellationReason,
  inferAgentFailureCode,
} from '../../shared/contract/agentFailure';
import { CANCELLATION_TIMEOUTS } from '../../shared/constants';
import { getUserDataPath } from '../platform/appPaths';
import { join as pathJoin } from 'path';
import { captureWorkspacePatch } from '../services/checkpoint/taskPatchService';
import { getPlanApprovalGate } from './planApproval';
import { getSpawnGuard } from './spawnGuard';
import { buildChildContext, buildParentContextFromToolContext, type ParentContext } from './childContext';
import { getPermissionModeManager } from '../permissions/modes';
import { AgentTask, type SidecarMetadata } from './agentTask';
import { generateMessageId } from '../../shared/utils/id';
import { getSubagentContextStore } from '../context/subagentContextStore';
import { getConfigService } from '../services/core/configService';
import { applyInterventionsToMessages } from '../context/contextInterventionHelpers';
import { getContextInterventionState } from '../context/contextInterventionState';
import { getTelemetryCollector } from '../telemetry/telemetryCollector';
import {
  buildContextSnapshot,
  buildInferenceMessages,
  buildInitialSubagentMessages,
  buildObservation,
  buildSnapshotAnnotations,
  createRuntimeMessage,
  materializeObservedMessages,
  type RuntimeMessage,
} from './subagentExecutorProjection';
import { filterSubagentToolDefs } from './subagentExecutorToolDefs';
import {
  buildSubagentModelCall,
  drainSubagentMessages,
  recordSubagentTelemetryTurn,
  type SubagentTelemetryToolCall,
} from './subagentExecutorTelemetry';
import {
  createSubagentCancellationLifecycle,
  getChildSubagentExecutionTimeout,
  getSubagentIdleTimeout,
} from './subagentExecutorCancellation';
import {
  executeE2ELocalSubagent,
  shouldUseE2ELocalSubagentExecutor,
} from './subagentE2ELocalExecutor';
import { buildSubagentSkillsBlock } from '../services/skills/subagentSkillInjection';
import { buildRoleContextBlock, runRoleWriteBack, recordRoleParticipation } from '../services/roleAssets';
import { resolveModelDecision } from '../model/modelDecision';
import type { SubagentConfig, SubagentContext, SubagentResult } from './subagentExecutorTypes';
import { getIncompleteTasks, adoptOrphanTasks } from '../services/planning/taskStore';
import {
  addSubagentUsage,
  type SubagentUsage,
} from './subagentUsageAccounting';

export type { SubagentConfig, SubagentContext, SubagentResult } from './subagentExecutorTypes';

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
  async execute(
    prompt: string,
    config: SubagentConfig,
    context: SubagentContext
  ): Promise<SubagentResult> {
    // ADR-019 批 1：单一防御点——subagent 永不继承父会话的 adaptive 标志。
    // 所有 spawn 路径（Task 工具 / spawn_agent / parallel coordinator）都经过
    // 这里，入口归一化一次覆盖全部，下游 context.modelConfig 引用自动安全。
    const { config: normalizedModelConfig } = resolveModelDecision({
      requestedConfig: context.modelConfig,
      messages: [],
      context: 'subagent',
      subagentRole: config.name,
    });
    context = { ...context, modelConfig: normalizedModelConfig };

    if (shouldUseE2ELocalSubagentExecutor()) {
      return executeE2ELocalSubagent(prompt, config, context);
    }

    // Create AgentTask for lifecycle tracking
    const agentId = `agent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const taskMetadata: SidecarMetadata = {
      agentType: config.name,
      worktreePath: context.worktreePath,
      parentSessionId: context.toolContext.sessionId || 'unknown',
      spawnTime: Date.now(),
      model: context.modelConfig.model,
      toolPool: config.availableTools,
    };
    const agentTask = new AgentTask(agentId, taskMetadata);

    // Wire TaskCreated/TaskCompleted hooks via AgentTask lifecycle callbacks
    const sessionId = ((context.toolContext as ToolContext & { sessionId?: string }).sessionId || '').trim() || 'unknown';
    if (context.hookManager) {
      const hm = context.hookManager;
      agentTask.onHook = (event, payload) => {
        if (event === 'TaskCreated') {
          hm.triggerTaskCreated(payload.taskId, payload.agentType, sessionId)
            .catch(() => {});
        } else if (event === 'TaskCompleted') {
          hm.triggerTaskCompleted(payload.taskId, payload.agentType, payload.success ?? false, sessionId)
            .catch(() => {});
        }
      };
    }

    agentTask.register();
    agentTask.start();

    // Fire SubagentStart hook (fire-and-forget)
    if (context.hookManager) {
      context.hookManager.triggerSubagentStart(
        config.name,
        agentId,
        prompt,
        sessionId,
        context.parentToolUseId,
      ).catch(() => {});
    }

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
    // 跨迭代累加 outputTokens，供 dynamic-workflow 的 BudgetTracker 计费（每次推理后累加）。
    let outputTokensUsed = 0;
    let descendantUsage: SubagentUsage = { cost: 0, tokensUsed: 0 };

    // P3: 计算执行超时时间
    const timeout = getChildSubagentExecutionTimeout(config.name, config.maxExecutionTimeMs, {
      parentStartedAt: context.toolContext.spawnParentStartedAt,
      parentTimeoutMs: context.toolContext.spawnParentTimeoutMs,
    });
    const startTime = Date.now();

    const {
      effectiveController,
      effectiveSignal,
      cleanupTimer,
      markProgress,
      stopIdleWatchdog,
    } = createSubagentCancellationLifecycle({
      agentName: config.name,
      timeoutMs: timeout,
      parentSignal: context.abortSignal,
      onIdleTimeout: (idle) => {
        logger.warn(
          `[${config.name}] idle ${idle}ms exceeded ${getSubagentIdleTimeout(timeout)}ms (≤90% of ${timeout}ms budget), triggering idle-timeout`,
        );
      },
    });

    // GAP-011（课程"方向 A"）：skills 全文预注入子代理 system prompt。
    // 只注入知识，不改变 availableTools 权限边界（与 GAP-001 fork 限权正交）。
    let effectiveSystemPrompt = config.systemPrompt;
    if (config.skills && config.skills.length > 0) {
      const { block, loaded, missing } = await buildSubagentSkillsBlock(config.skills);
      if (block) {
        effectiveSystemPrompt = `${config.systemPrompt}\n\n${block}`;
      }
      logger.info(`[${config.name}] skills preloaded into system prompt`, { loaded, missing });
    }

    // 持久化角色资产注入（设计 内部文档 §5 步骤 1）：
    // roles/<roleId>/ 目录存在 → 注入角色记忆索引 + 项目记忆索引 + 最近履历。
    // 非持久角色返回 null，行为与此功能上线前完全一致。失败不阻塞 spawn。
    if (config.roleId) {
      try {
        const roleBlock = await buildRoleContextBlock(
          config.roleId,
          context.toolContext.workingDirectory,
        );
        if (roleBlock) {
          effectiveSystemPrompt = `${effectiveSystemPrompt}\n\n${roleBlock}`;
          logger.info(`[${config.name}] role assets injected`, { roleId: config.roleId });
        }
      } catch (err) {
        logger.warn(`[${config.name}] role assets injection failed (non-blocking)`, err);
      }
    }

    // Create pipeline context
    const pipeline = getSubagentPipeline();
    const dynamicConfig: DynamicAgentConfig = {
      name: config.name,
      systemPrompt: effectiveSystemPrompt,
      tools: config.availableTools,
      maxIterations: config.maxIterations,
      permissionPreset: config.permissionPreset || 'development',
      maxBudget: config.maxBudget,
    };
    const pipelineContext = pipeline.createContext(
      dynamicConfig,
      context.toolContext.workingDirectory,
      undefined,
      { parentRemainingBudget: context.parentRemainingBudget },
    );
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

    // Filter tools to only those allowed for this subagent（下方 if/else 两档必赋值）
    let effectiveToolNames: string[];

    // M2-Task 5 partial: 走 buildChildContext 三档合并算法
    // P4 收敛点：caller 没显式传 parentContext 时，自动从 ToolContext 推导，
    // 而不是让 10+ caller 各自写一遍 parentContext 字面量（plan §3.4 / R4）。
    let effectiveParentContext: ParentContext | undefined = context.parentContext;
    if (!effectiveParentContext) {
      const wideCtx = context.toolContext as ToolContext & {
        parentAvailableTools?: string[];
        parentPermissionMode?: string;
      };
      effectiveParentContext = buildParentContextFromToolContext(context.toolContext, {
        // 顶层 agent 默认看到所有声明的工具；availableTools 为空时不会触发 narrowing
        // （toolPool = parent.allTools ∩ child.declared 会退化成 child.declared，
        //  也就是不变）。
        availableTools: wideCtx.parentAvailableTools ?? [],
        permissionMode: wideCtx.parentPermissionMode ?? (getPermissionModeManager().getMode() as string),
      });
      logger.debug(`[${config.name}] parentContext auto-derived from ToolContext (caller did not provide explicit context)`);
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

    // tools 交集是核心约束（永不扩张），三档都生效；
    // 当 parent.availableTools 为空（caller 没显式传）时 intersect 结果为 []，
    // 此时退化为 child.allowedTools（避免无害 caller 拿不到任何工具）。
    if (effectiveParentContext.availableTools.length === 0) {
      effectiveToolNames = config.availableTools;
    } else {
      effectiveToolNames = childCtx.toolPool;
    }

    logger.info(`[${config.name}] childContext applied`, {
      inheritance,
      parentTools: effectiveParentContext.availableTools.length,
      childDeclared: config.availableTools.length,
      toolPool: effectiveToolNames.length,
      denyMerged: childCtx.permissions.deny.length,
      effectiveMode: childCtx.permissions.effectiveMode,
      explicitParent: !!context.parentContext,
    });

    const allowedToolDefs = filterSubagentToolDefs(effectiveToolNames, context.toolResolver);
    const allowedNames = new Set(allowedToolDefs.map((d) => d.name));

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
    const { runId: nativeRunId, workspace, workingDirectory } = context.toolContext;
    const nativeRunContext = nativeRunId && sessionId && workspace
      ? createRunContext({ runId: nativeRunId, sessionId, workspace, cwd: workingDirectory })
      : undefined;
    const subagentToolExecutor = new ToolExecutor({
      workingDirectory: nativeRunContext?.cwd ?? context.toolContext.workingDirectory,
      runContext: nativeRunContext,
      // subagent 非交互：这是 classifier 'ask' 的兜底。硬阻断（validateCommand /
      // classifier-deny / exec-policy / subagentPolicy deny）已在 ToolExecutor 管道内生效，
      // 高风险走下方 loop 内的 plan-approval gate。
      // P0(G18): 只有收缩后的有效 mode 本身免确认（bypassPermissions / acceptEdits）才自动放行；
      // 否则保守拒绝 —— 父 agent 此时会弹用户确认，子 agent 不能替用户做主、不能越父权限。
      requestPermission: async () =>
        subagentEffectiveMode === 'bypassPermissions' || subagentEffectiveMode === 'acceptEdits',
    });
    const subagentPolicy = {
      allowedTools: allowedNames,
      check: (toolName: string, params: Record<string, unknown>): 'deny' | 'ask' => {
        const def = context.toolResolver.getDefinition(toolName);
        const req: ToolExecutionRequest = {
          toolName,
          permissionLevel: def?.permissionLevel ?? 'read',
          path: (params.path as string | undefined) ?? (params.file_path as string | undefined),
          command: params.command as string | undefined,
          url: params.url as string | undefined,
        };
        return pipeline.checkToolExecution(pipelineContext, req).allowed ? 'ask' : 'deny';
      },
    };

    // Check if the model supports tool calls
    const providerConfig = PROVIDER_REGISTRY[context.modelConfig.provider];
    const modelInfo = providerConfig?.models.find((m: { id: string; supportsTool?: boolean }) => m.id === context.modelConfig.model);
    const supportsTool = modelInfo?.supportsTool ?? true; // Default to true if unknown

    // Only provide tool definitions if the model supports them
    const toolDefinitions = supportsTool ? allowedToolDefs.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      requiresPermission: tool.requiresPermission,
      permissionLevel: tool.permissionLevel,
    })) : [];

    if (!supportsTool && allowedToolDefs.length > 0) {
      logger.warn(`[${config.name}] Model ${context.modelConfig.model} does not support tool calls, tools will be ignored`);
    }

    const subagentContextStore = getSubagentContextStore();
    // Parallel/Team callers provide a stable composite execution identity.
    // Keep the pipeline's internal random id private to the pipeline registry;
    // user-facing events, tool calls, approvals and results must stay in the
    // caller's run scope.
    const executionAgentId = context.executionAgentId || context.spawnGuardId || pipelineContext.agentId;
    const telemetryCollector = getTelemetryCollector();
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
      toolsUsed,
      context.attachments,
    );
    const emitContextSnapshot = (messageOverride?: RuntimeMessage[]): void => {
      const effectiveMessages = messageOverride || messages;
      latestContextSnapshot = buildContextSnapshot(
        effectiveMessages,
        context.modelConfig.model,
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
    if (parentToolUseId && context.toolContext.emit) {
      context.toolContext.emit('agent_thinking', {
        message: `Subagent [${config.name}] starting...`,
        agentId: executionAgentId,
        parentToolUseId,
      });
    }

    try {
      // Initial budget check
      const budgetCheck = pipeline.checkBudget(pipelineContext);
      if (!budgetCheck.allowed) {
        pipeline.completeContext(pipelineContext.agentId, false, budgetCheck.reason);
        agentTask.fail(budgetCheck.reason || 'budget exceeded');
        // orphan 接管（roadmap 2.6）：subagent 名下未收口任务释放回主会话
        adoptOrphanTasks(sessionId, pipelineContext.agentId);
        // Fire SubagentStop on early budget failure
        context.hookManager?.triggerSubagentStop(config.name, undefined, sessionId, agentTask.id).catch(silence(logger, 'triggerSubagentStop:budget', 'warn'));
        return {
          success: false,
          output: '',
          error: budgetCheck.reason,
          toolsUsed: [],
          iterations: 0,
          tokensUsed: getTotalTokens(),
          cost: getTotalCost(),
          agentId: executionAgentId,
          contextSnapshot: latestContextSnapshot,
          // swarm 护栏 P1-2 #1：子代理触顶自身预算 → 结构化失败码，
          // 编排层 routeFailureCode 据此降级（'degrade'）而非 parse error 字符串。
          cancellationReason: 'child-max-tokens',
          failureCode: AgentFailureCode.BudgetExhausted,
        };
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
          // sessionDir convention: <userDataPath>/sessions/<sessionId>.
          // saveToDisk creates the agent subdir itself; we just hand it
          // the session root.
          const sessionDir = pathJoin(getUserDataPath(), 'sessions', sessionId);
          // R5 — agentPromise self-reference: this is the running executor's
          // own loop. We pass `Promise.resolve()` so the grace phase
          // doesn't deadlock waiting for ourselves; the abort signal has
          // already propagated to inference / tools, their cleanup runs
          // in parallel.
          try {
            await initiateShutdown(effectiveController, Promise.resolve(), {
              gracePeriodMs: CANCELLATION_TIMEOUTS.GRACEFUL_SHUTDOWN_GRACE,
              label: `${config.name}:${agentTask.id}`,
              onFlush: async () => {
                try {
                  await agentTask.saveToDisk(sessionDir);
                } catch (err) {
                  logger.warn(
                    `[${config.name}] saveToDisk failed during flush`,
                    err,
                  );
                }
                // 取消时把工作目录的文件改动抢救成 patch（saveToDisk 只存 transcript）。
                // 有 worktree 用 worktree 路径，否则用会话工作目录。best-effort 不阻塞取消。
                try {
                  const patchDir =
                    context.worktreePath || context.toolContext.workingDirectory;
                  if (patchDir) {
                    await captureWorkspacePatch(patchDir, agentTask.id, 'cancel');
                  }
                } catch (err) {
                  logger.warn(
                    `[${config.name}] captureWorkspacePatch failed during flush`,
                    err,
                  );
                }
              },
            });
          } catch (err) {
            logger.warn(`[${config.name}] initiateShutdown threw`, err);
          }

          pipeline.completeContext(pipelineContext.agentId, false, cancellationReason);
          const errorMsg = cancellationReason === 'timeout'
            ? `执行超时 (${Math.round(timeout / 1000)}秒)，已完成 ${iterations} 次迭代`
            : cancellationReason === 'idle-timeout'
              ? `子代理 ${Math.round(getSubagentIdleTimeout(timeout) / 1000)}s 无 stream/progress, 已自动取消 (idle-timeout)`
              : `任务已取消 (${cancellationReason})`;
          agentTask.fail(errorMsg);
          // orphan 接管（roadmap 2.6）
          adoptOrphanTasks(sessionId, pipelineContext.agentId);
          if (context.spawnGuardId) {
            getSpawnGuard().cancelDescendants(context.spawnGuardId, 'parent-cancel');
          }
          // Fire SubagentStop on abort/timeout
          context.hookManager?.triggerSubagentStop(config.name, undefined, sessionId, agentTask.id).catch(silence(logger, 'triggerSubagentStop:abort', 'warn'));
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
          const pendingMessages = [
            ...(context.spawnGuardId ? getSpawnGuard().drainMessages(context.spawnGuardId) : []),
            ...(context.messageDrain ? context.messageDrain() : []),
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
        }

        // Check budget before each iteration
        const iterBudgetCheck = pipeline.checkBudget(pipelineContext);
        if (!iterBudgetCheck.allowed) {
          logger.warn(`[${config.name}] Budget exceeded at iteration ${iterations}`);
          break;
        }

        // Auto-compaction: truncate old messages if approaching context limit
        if (iterations > SUBAGENT_COMPACTION.SKIP_FIRST_ITERATIONS) {
          if (compactSubagentMessages(messages, context.modelConfig.model)) {
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
        const telemetryTurnId = generateMessageId();
        const telemetryTurnStartedAt = Date.now();
        const currentTelemetryTurnNumber = ++telemetryTurnNumber;
        const telemetryToolCalls: SubagentTelemetryToolCall[] = [];

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
          && aiSdkSupportsProvider(context.modelConfig.provider);
        // per-request 超时取执行预算的一半：单次 provider 卡住（接受连接但响应不返回）时在 ~budget/2 早退 +
        // withTransientRetry 重试（重发常能过），而非把整个子代理预算耗在一次挂死上——旧 AI SDK 路径无
        // per-request 超时，一次 stall = 整个子代理跑满 90s 硬超时报废（实测 zhipu glm-4-flash 偶发）。
        const subagentRequestTimeoutMs = Math.floor(timeout / 2);
        const response = useAiSdk
          ? await inferenceViaAiSdk(inferenceMessages as unknown as Parameters<typeof inferenceViaAiSdk>[0], toolDefinitions, context.modelConfig, undefined, effectiveSignal, { requestTimeoutMs: subagentRequestTimeoutMs })
          : await this.modelRouter.inference(
              providerMessages,
              toolDefinitions,
              context.modelConfig,
              () => {}, // No streaming for subagents
              effectiveSignal,
            );
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
              ? context.toolResolver.getDefinition(toolCall.name)
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
              const risk = gate.assessRisk(toolRequest, context.toolContext.workingDirectory);
              if (risk.level !== 'low') {
                const approval = await gate.submitForApproval({
                  agentId: executionAgentId,
                  agentName: config.name,
                  coordinatorId: config.coordinatorId || 'coordinator',
                  plan: `Tool: ${toolCall.name}\nArgs: ${JSON.stringify(toolCall.arguments)}\nRisk: ${risk.reasons.join(', ')}`,
                  risk,
                  scope: context.toolContext.swarmRunScope,
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
            if (parentToolUseId && context.toolContext.emit) {
              context.toolContext.emit('tool_call_start', {
                id: toolCall.id,
                name: toolCall.name,
                arguments: toolCall.arguments,
                parentToolUseId,
              });
            }

            const toolStartTime = Date.now();
            try {
              const result = await subagentToolExecutor.execute(
                toolCall.name,
                toolCall.arguments,
                {
                  runId: context.toolContext.runId,
                  sessionId: (context.toolContext as { sessionId?: string }).sessionId,
                  agentId: executionAgentId,
                  spawnDepth: context.toolContext.spawnDepth,
                  spawnMaxDepth: context.toolContext.spawnMaxDepth,
                  spawnTreeId: context.toolContext.spawnTreeId,
                  swarmRunScope: context.toolContext.swarmRunScope,
                  spawnQueueTimeoutMs: context.toolContext.spawnQueueTimeoutMs,
                  spawnParentStartedAt: startTime,
                  spawnParentTimeoutMs: timeout,
                  parentRemainingBudget: getRemainingTreeBudget(),
                  spawnParentAgentId: context.spawnGuardId,
                  // 持久化角色 ID → 透传给工具层（MemoryWrite/Read scope='role' 路由用）
                  agentRole: config.roleId,
                  hookManager: context.hookManager,
                  abortSignal: effectiveSignal,
                  currentToolCallId: toolCall.id,
                  toolScope: context.toolContext.toolScope,
                  emitEvent: context.toolContext.emit,
                  modelConfig: context.modelConfig,
                  subagentPolicy,
                },
              );
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
              if (parentToolUseId && context.toolContext.emit) {
                context.toolContext.emit('tool_call_end', {
                  toolCallId: toolCall.id,
                  success: result.success,
                  output: result.output,
                  error: result.error,
                  duration: toolDuration,
                  parentToolUseId,
                });
              }
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
              if (parentToolUseId && context.toolContext.emit) {
                context.toolContext.emit('tool_call_end', {
                  toolCallId: toolCall.id,
                  success: false,
                  error: errorMessage,
                  duration: toolDuration,
                  parentToolUseId,
                });
              }
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
      if (context.hookManager) {
        context.hookManager.triggerSubagentStop(
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
          workspacePath: context.toolContext.workingDirectory,
          taskPrompt: prompt,
          finalOutput,
          artifacts: instanceArtifacts,
        }).catch(silence(logger, 'runRoleWriteBack', 'warn'));

        // 角色参与记录：主 run 结束后据此触发 event 醒来（内部文档 §2.2）
        recordRoleParticipation(sessionId, config.roleId);
      }

      return {
        success: true,
        output: finalOutput || 'Subagent completed without output',
        toolsUsed: [...new Set(toolsUsed)],
        iterations,
        tokensUsed: getTotalTokens(),
        cost: getTotalCost(),
          agentId: executionAgentId,
        contextSnapshot: latestContextSnapshot,
      };
    } catch (error) {
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
      if (context.hookManager) {
        context.hookManager.triggerSubagentStop(
          config.name,
          undefined,
          sessionId,
          agentTask.id,
        ).catch(() => {});
      }

      // 把已消耗的 outputTokens 挂到 error 上，让 dynamic-workflow 的 BudgetTracker 在抛出路径
      // 也能记账（provider 产出部分 output 后崩的场景，Codex R2 MED#4）。不影响既有错误处理。
      if (error && typeof error === 'object') {
        try {
          (error as { tokensUsed?: number; cost?: number }).tokensUsed = getTotalTokens();
          (error as { tokensUsed?: number; cost?: number }).cost = getTotalCost();
        } catch { /* frozen error, ignore */ }
      }
      throw error; // re-throw to preserve existing error handling
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

    return this.execute(prompt, config, context);
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
