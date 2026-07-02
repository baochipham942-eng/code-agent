// ============================================================================
// ConversationRuntime — Main loop, step execution, plan mode, cancel/interrupt/steer
// Extracted from AgentLoop
// ============================================================================

// ============================================================================
// Agent Loop - Core event loop for AI agent execution
// Enhanced with Manus-style persistent planning hooks
// ============================================================================

import type {
  Message,
  MessageAttachment,
  MessageMetadata,
  AgentEvent,
} from '../../../shared/contract';
import type { StructuredOutputConfig, StructuredOutputResult } from '../../agent/structuredOutput';
import { generateFormatCorrectionPrompt } from '../../agent/structuredOutput';
import type { PlanningService } from '../../planning';
import { recordSessionStart } from '../../lightMemory/sessionMetadata';
import { getLangfuseService, getBudgetService } from '../../services';
import { logCollector } from '../../mcp/logCollector.js';
import { generateMessageId } from '../../../shared/utils/id';
import { taskComplexityAnalyzer } from '../../planning/taskComplexityAnalyzer';
import { classifyIntent } from '../../routing/intentClassifier';
import { getTaskOrchestrator } from '../../planning/taskOrchestrator';
import { preloadToolsForIntent } from './intentToolPreload';
import { createLogger } from '../../services/infra/logger';
import { createHookManager } from '../../hooks';
import { getDiagnosticVersions } from '../../telemetry/diagnosticVersions';
import { getContextWindow } from '../../../shared/constants';

import { writeTurnSnapshot } from './turnSnapshotWriter';
import { maybePauseForStep } from './stepPause';
import { activateMaxStepsFinalResponse } from './maxStepsFallback';
import { DoomLoopGuard } from './doomLoopGuard';
import { generateAutoContinuationPrompt as buildAutoContinuationPrompt } from './truncationPrompts';

// Import refactored modules
import type { AgentLoopConfig } from '../../agent/loopTypes';
import { buildDynamicPromptV2 } from '../../prompts/builder';
import { detectTaskFeatures } from '../../prompts/systemReminders';
import { getSessionRecoveryService } from '../../agent/sessionRecovery';
import {
  advanceTodoStatus,
  setSessionTodos,
  syncTodosToSessionTasks,
} from '../../agent/todoParser';
import { WRITE_TOOLS } from '../../agent/loopTypes';
import { decideNextAction, type LoopState } from '../loopDecision';
import type { RuntimeContext } from './runtimeContext';
import type { ToolExecutionEngine } from './toolExecutionEngine';
import type { ContextAssembly } from './contextAssembly';
import type { RunFinalizer, RunTerminalInfo } from './runFinalizer';
import type { LearningPipeline } from './learningPipeline';
import { MessageProcessor } from './messageProcessor';
import { StreamHandler } from './streamHandler';
import { goalTokensUsedWithSwarm, maybeInjectSwarmGuidance } from './swarmGoalIntegration';
import {
  buildSkillInvocationContext,
  resolveSkillInvocation,
} from '../../services/skills/skillInvocationResolver';
import {
  hasActiveSessionTodos,
  isSessionFirstUserTurn,
  queueRuntimeDiagnostic,
  todosFromPlan,
} from './conversationRuntimePlanning';
import {
  bootstrapDesktopDerivedContext,
  injectActivityContext,
  injectSeedMemory,
  persistFailedRunContinuationContext,
} from './conversationRuntimeContextBootstrap';
import { resolveStickyStrictSkillInvocation } from './conversationRuntimeStickySkill';


const logger = createLogger('AgentLoop');

// Re-export types for backward compatibility
export type { AgentLoopConfig };

// ----------------------------------------------------------------------------
// Agent Loop
// ----------------------------------------------------------------------------

/**
 * Agent Loop - AI Agent 的核心执行循环
 *
 * 实现 ReAct 模式的推理-行动循环：
 * 1. 调用模型进行推理（inference）
 * 2. 解析响应（文本或工具调用）
 * 3. 执行工具（带权限检查）
 * 4. 将结果反馈给模型
 * 5. 重复直到完成或达到最大迭代次数
 */

export class ConversationRuntime {
  toolEngine!: ToolExecutionEngine;
  contextAssembly!: ContextAssembly;
  runFinalizer!: RunFinalizer;
  learningPipeline!: LearningPipeline;
  private messageProcessor!: MessageProcessor;
  private streamHandler!: StreamHandler;
  private pauseResolvers: Array<() => void> = [];

  constructor(protected ctx: RuntimeContext) {}

  setModules(
    toolEngine: ToolExecutionEngine,
    contextAssembly: ContextAssembly,
    runFinalizer: RunFinalizer,
    learningPipeline: LearningPipeline,
  ): void {
    this.toolEngine = toolEngine;
    this.contextAssembly = contextAssembly;
    this.runFinalizer = runFinalizer;
    this.learningPipeline = learningPipeline;
    this.messageProcessor = new MessageProcessor(this.ctx, contextAssembly, runFinalizer, toolEngine);
    this.streamHandler = new StreamHandler(this.ctx, contextAssembly, runFinalizer);
  }

  // Convenience: emit event through context
  protected onEvent(event: AgentEvent): void {
    this.ctx.onEvent(event);
  }

  private releasePauseWaiters(): void {
    const waiters = this.pauseResolvers.splice(0);
    for (const resolve of waiters) resolve();
  }

  private async waitWhilePaused(): Promise<void> {
    while (this.ctx.isPaused && !this.ctx.isCancelled && !this.ctx.isInterrupted) {
      await new Promise<void>((resolve) => {
        this.pauseResolvers.push(resolve);
      });
    }
  }

  async initializeUserHooks(): Promise<void> {
    if (this.ctx.userHooksInitialized) return;

    if (!this.ctx.hookManager && this.ctx.enableHooks) {
      const hookWorkingDirectory = this.ctx.workingDirectory?.trim() || process.cwd();
      this.ctx.hookManager = createHookManager({
        workingDirectory: hookWorkingDirectory,
        onTrigger: (entry) => {
          this.ctx.onEvent({
            type: 'hook_trigger',
            data: {
              ...entry,
              sessionId: this.ctx.sessionId,
              ...(this.ctx.currentTurnId ? { turnId: this.ctx.currentTurnId } : {}),
            },
          });
        },
      });
    }

    if (this.ctx.hookManager) {
      await this.ctx.hookManager.initialize();
      this.ctx.userHooksInitialized = true;

      // Bridge planning hooks to user hook system (fire-and-forget)
      if (this.ctx.planningService) {
        this.ctx.planningService.setBridgeHookManager(this.ctx.hookManager, this.ctx.sessionId);
      }
    }
  }

  // 薄封装：逻辑在 conversationRuntimeContextBootstrap，方法体保留供 initializeRun 调用
  // 与单测 spy（桌面活动注入 / bootstrap 失败降级回归保护）。
  private async bootstrapDesktopDerivedContext(userMessage?: string): Promise<void> {
    return bootstrapDesktopDerivedContext(this.ctx, this.contextAssembly, userMessage);
  }

  private async injectActivityContext(options: { includeDesktopActivity: boolean }): Promise<void> {
    return injectActivityContext(this.contextAssembly, options);
  }

  setPlanMode(active: boolean): void {
    this.ctx.isPlanModeActive = active;
    this.ctx.planModeActive = active;

    if (active) {
      this.ctx.savedMessages = [...this.ctx.messages];
      this.contextAssembly.injectSystemMessage(
        `<plan-mode>\n` +
        `You are now in PLAN MODE. Do NOT execute any tools.\n` +
        `Instead, analyze the request and provide a detailed step-by-step plan.\n` +
        `Format your plan as a numbered list with clear, actionable steps.\n` +
        `Wait for user approval before proceeding with execution.\n` +
        `</plan-mode>`
      );
      logger.info('[AgentLoop] Plan mode activated');
    } else {
      if (this.ctx.savedMessages) {
        this.ctx.messages.length = 0;
        this.ctx.messages.push(...this.ctx.savedMessages);
        this.ctx.savedMessages = null;
      }
      logger.info('[AgentLoop] Plan mode deactivated');
    }
  }

  isPlanMode(): boolean {
    return this.ctx.isPlanModeActive;
  }

  setStructuredOutput(config: StructuredOutputConfig | undefined): void {
    this.ctx.structuredOutput = config;
    this.ctx.structuredOutputRetryCount = 0;
  }

  getStructuredOutput(): StructuredOutputConfig | undefined {
    return this.ctx.structuredOutput;
  }

  shouldRetryStructuredOutput(result: StructuredOutputResult): boolean {
    if (result.success) return false;
    return this.ctx.structuredOutputRetryCount < this.ctx.maxStructuredOutputRetries;
  }
  injectStructuredOutputCorrection(result: StructuredOutputResult): void {
    if (!this.ctx.structuredOutput) return;

    this.ctx.structuredOutputRetryCount++;
    const correctionPrompt = generateFormatCorrectionPrompt(
      result.rawContent || '',
      this.ctx.structuredOutput.schema,
      result.validationErrors || [result.error || 'Unknown error']
    );
    this.contextAssembly.injectSystemMessage(correctionPrompt);
    logger.debug(`[AgentLoop] Structured output correction injected (retry ${this.ctx.structuredOutputRetryCount}/${this.ctx.maxStructuredOutputRetries})`);
  }

  shouldAutoEnableStepByStep(): boolean {
    return this.ctx.stepByStepMode;
  }

  parseMultiStepTask(prompt: string): { steps: string[]; isMultiStep: boolean } {
    const lines = prompt.split('\n').filter(l => /^\s*(\d+[.)]\s|[-*]\s)/.test(l));
    return {
      steps: lines.map(l => l.replace(/^\s*(\d+[.)]\s|[-*]\s)/, '').trim()),
      isMultiStep: lines.length >= 2,
    };
  }

  async runStepByStep(userMessage: string, steps: string[]): Promise<boolean> {
    logger.info(`[AgentLoop] Running step-by-step mode with ${steps.length} steps`);

    this.contextAssembly.injectSystemMessage(
      `<step-by-step-mode>\n` +
      `This task has been broken down into ${steps.length} steps.\n` +
      `Execute each step one at a time, verifying completion before moving to the next.\n` +
      `Steps:\n${steps.map((s, i) => `${i + 1}. ${s}`).join('\n')}\n` +
      `\nStart with step 1. After completing each step, explicitly state "Step N completed" before moving on.\n` +
      `</step-by-step-mode>`
    );

    for (let i = 0; i < steps.length; i++) {
      const stepPrompt = i === 0
        ? userMessage
        : `Continue with step ${i + 1}: ${steps[i]}. Previous steps have been completed.`;

      logger.debug(`[AgentLoop] Step ${i + 1}/${steps.length}: ${steps[i].substring(0, 50)}`);

      await this.run(stepPrompt);

      if (this.ctx.isCancelled || this.ctx.isInterrupted) {
        logger.info(`[AgentLoop] Step-by-step interrupted at step ${i + 1}`);
        return false;
      }
    }

    return true;
  }

  async run(userMessage: string): Promise<void> {

    const initResult = await this.initializeRun(userMessage);
    if (!initResult) return; // Early exit (step-by-step mode or hook blocked)
    const { langfuse, isSimpleTask, genNum } = initResult;

    this.ctx.runAbortController = new AbortController();

    let iterations = 0;
    let userTurnId: string | undefined;
    let terminal: RunTerminalInfo = { status: 'completed' };
    let runError: unknown;
    // Doom loop 三层防护（roadmap 1.2）：per-run 实例化 = 计数器每轮用户输入重置
    const doomLoopGuard = new DoomLoopGuard();

    try {
      while (!this.ctx.isCancelled && !this.ctx.isInterrupted && !this.ctx.circuitBreaker.isTripped() && iterations < this.ctx.maxIterations) {
        await this.waitWhilePaused();
        if (this.ctx.isCancelled || this.ctx.isInterrupted) break;

        iterations++;
        this.ctx.turnTrace.setTurn(iterations);
        logger.debug(` >>>>>> Iteration ${iterations} START <<<<<<`);

        // Check for interrupt at the start of each iteration
        if (this.ctx.isInterrupted && this.ctx.interruptMessage) {
          logger.info('[AgentLoop] Interrupt detected, breaking loop');
          this.ctx.onEvent({
            type: 'interrupt_acknowledged',
            data: { message: '已收到新指令，正在调整方向...' },
          });
          break;
        }

        // Budget check
        const budgetBlocked = this.runFinalizer.checkAndEmitBudgetStatus();
        if (budgetBlocked) {
          logger.warn('[AgentLoop] Budget exceeded, stopping execution');
          logCollector.agent('WARN', 'Budget exceeded, execution blocked');
          this.ctx.onEvent({
            type: 'error',
            data: { message: 'Budget exceeded. Please increase budget or wait for reset.', code: 'BUDGET_EXCEEDED' },
          });
          break;
        }

        // Max-steps 兜底（借鉴 MiMoCode max-steps.txt）：进入最后一轮时禁用工具，
        // 强制纯文本三段式总结（已完成/未完成/建议下一步），避免步数耗尽无收尾直接断流。
        if (iterations >= this.ctx.maxIterations && this.ctx.maxIterations > 1) {
          activateMaxStepsFinalResponse(this.ctx);
          logger.warn('[AgentLoop] Max iterations reached; forcing tool-free final summary', {
            iterations,
            maxIterations: this.ctx.maxIterations,
          });
        }

        // Goal mode 闸3（兜底，每轮先跑）：轮次/预算/无进展任一触发即标 aborted 收尾。
        // 放在 loop 顶而非收尾点——否则 handleToolResponse 返回 'continue' 的轮次会跳过闸3。
        if (this.ctx.goalMode?.isPending()) {
          // 记录上一轮有无进展：toolsUsedInTurn 此刻尚未被 setupIteration 重置，仍是上一轮的工具。
          // 用了写工具或 Bash 视为有进展（清零）；纯 read-only/无工具视为无进展（累加）。
          // 连续 NO_PROGRESS_THRESHOLD 轮无进展 → evaluateFallback 触发闸3 中止。
          if (iterations > 1) {
            const madeProgress = this.ctx.toolsUsedInTurn.some(
              (t) => WRITE_TOOLS.includes(t) || t === 'Bash' || t === 'bash',
            );
            this.ctx.goalMode.recordTurnProgress(madeProgress);
          }
          // 主 agent 消耗；swarm 消耗在 evaluateFallback 内部统一加总，观测事件用加总值展示
          const tokensUsed = this.ctx.totalInputTokens + this.ctx.totalOutputTokens;
          const tokensUsedWithSwarm = goalTokensUsedWithSwarm(this.ctx);
          // 观测事件：每轮 goal 进度态（UI 用）
          // 墙钟已用时间（①）：以 run 起点为基准；闸3 与 UI 剩余时间共用。
          const elapsedMs = Date.now() - this.ctx.runStartTime;
          this.ctx.onEvent({
            type: 'goal_iteration',
            data: {
              turn: iterations,
              maxTurns: this.ctx.goalMode.getMaxTurns(),
              goalStatus: this.ctx.goalMode.getStatus(),
              tokensUsed: tokensUsedWithSwarm,
              tokenBudget: this.ctx.goalMode.getTokenBudget(),
              wallClockBudgetMs: this.ctx.goalMode.getWallClockBudgetMs(),
            },
          });
          const fallback = this.ctx.goalMode.evaluateFallback({ turn: iterations, tokensUsed, elapsedMs });
          if (fallback.stop) {
            const reason = fallback.reason ?? 'goal aborted';
            this.ctx.goalMode.markAborted(reason);
            // 终态事件：闸3 兜底中止（UI 展示"目标已中止"+停表）
            this.ctx.onEvent({
              type: 'goal_complete',
              data: { status: 'aborted', reason, turns: iterations, tokensUsed: tokensUsedWithSwarm },
            });
            terminal = { status: 'aborted' };
            break;
          }

          // Swarm goal（P4）：allowSwarm 时首轮注入一次编排引导
          maybeInjectSwarmGuidance(this.ctx, (m) => this.contextAssembly.injectSystemMessage(m), iterations);

          // Codex 式审计 nudge：每 CHECKPOINT_INTERVAL 轮强制重注入"先假设没做完、
          // 逐项找证据"的完成前自检框架，对抗模型过早自报完成（pi-goal 上下文注入思路）。
          if (this.ctx.goalMode.shouldInjectAudit(iterations)) {
            this.contextAssembly.injectSystemMessage(this.ctx.goalMode.buildAuditNudge());
            logger.debug('[GoalMode] audit nudge injected', { turn: iterations });
          }
        }

        // Setup iteration (turn ID, spans, events, goal checkpoints)
        this.streamHandler.setupIteration(iterations, userMessage, langfuse);
        if (iterations === 1) {
          userTurnId = this.ctx.currentTurnId;
        }

        // Telemetry: record turn start (only first iteration has the real user prompt)
        this.ctx.telemetryAdapter?.onTurnStart(this.ctx.currentTurnId, iterations, iterations === 1 ? userMessage : '', iterations > 1 ? userTurnId : undefined);

        // Debug snapshot: 记录 turn 起始时的 messages 快照，post-inference 直接从 response.usage 取 token
        const turnStartMessageSnapshot = this.ctx.messages.slice();

        // Plan Feedback Loop
        await this.streamHandler.injectPlanContext(iterations);

        // Contextual Memory Retrieval — on first iteration
        if (iterations === 1) {
          await this.streamHandler.injectContextualMemory(userMessage);
        }

        // 1. Call model
        logger.debug('[AgentLoop] Calling inference...');
        const inferenceStartTime = Date.now();
        let response = await this.contextAssembly.inference();
        const inferenceDuration = Date.now() - inferenceStartTime;
        logger.debug('[AgentLoop] Inference response type:', response.type);

        // h2A 实时转向
        if (this.ctx.needsReinference) {
          this.ctx.needsReinference = false;
          logger.info('[AgentLoop] Steer detected after inference — re-inferring with new user message');
          this.ctx.onEvent({
            type: 'interrupt_acknowledged',
            data: { message: '已收到新指令，正在调整方向...' },
          });
          continue;
        }

        // Emit model_response and accumulate tokens
        this.streamHandler.emitModelResponse(response, inferenceDuration);

        langfuse.logEvent(this.ctx.traceId, 'inference_complete', {
          iteration: iterations,
          responseType: response.type,
          duration: inferenceDuration,
        });

        this.ctx.turnTrace.record('inference', {
          responseType: response.type,
          durationMs: inferenceDuration,
          inputTokens: response.usage?.inputTokens ?? 0,
          outputTokens: response.usage?.outputTokens ?? 0,
          finishReason: response.finishReason ?? null,
          truncated: response.truncated ?? false,
        });

        // Telemetry: record model call
        this.messageProcessor.recordModelCallTelemetry(response, iterations, inferenceDuration);

        // Debug snapshot: 落一条 turn 快照（给设置页 / debug session 用）
        // 在 post-inference 写入，token 字段反映本轮实际消耗（直接取 response.usage）
        writeTurnSnapshot({
          sessionId: this.ctx.sessionId,
          turnId: this.ctx.currentTurnId,
          turnIndex: iterations,
          systemPrompt: this.ctx.systemPrompt,
          messages: turnStartMessageSnapshot,
          inputTokens: response.usage?.inputTokens ?? 0,
          outputTokens: response.usage?.outputTokens ?? 0,
          inferenceDurationMs: inferenceDuration,
        });

        // Debug step mode: CODE_AGENT_STEP_MODE=true 时阻塞等用户回车
        await maybePauseForStep(iterations);

        // M1: Loop decision engine. Decisions are advisory here; concrete
        // recovery paths live in the response/tool handlers where full
        // conversation state is available.
        {
          const loopState: LoopState = {
            stopReason: response.finishReason ?? (response.truncated ? 'max_tokens' : 'end_turn'),
            tokenUsage: {
              input: this.ctx.totalInputTokens,
              output: this.ctx.totalOutputTokens,
            },
            maxTokens: getContextWindow(this.ctx.modelConfig.model),
            errorType: null,
            consecutiveErrors: this.ctx.consecutiveErrors,
            // budgetRemaining: budgetService 真实剩余比例（0-1）；未配预算时 usagePercentage=0 → 1.0，不误触发停止闸
            budgetRemaining: Math.max(0, Math.min(1, 1 - getBudgetService().checkBudget().usagePercentage)),
            iterationCount: iterations,
            maxIterations: this.ctx.maxIterations,
          };

          const decision = decideNextAction(loopState);
          logger.debug(`[AgentLoop] Loop decision: ${decision.action} (${decision.execution}) - ${decision.reason}`);

          if (decision.execution === 'advisory') {
            logger.info(`[AgentLoop] Advisory loop decision: ${decision.action} - ${decision.reason}`);
          }

          // G20: 把决策落进结构化 trace，不再只 log 就丢 —— 这是 G1（决策死区）
          // 可观测化的前置：等 trace 有数据后才能判定 G1 是核心缺口还是废抽象。
          this.ctx.turnTrace.record('loop_decision', {
            action: decision.action,
            execution: decision.execution,
            reason: decision.reason,
            stopReason: loopState.stopReason,
            consecutiveErrors: loopState.consecutiveErrors,
            contextRatio: loopState.maxTokens > 0
              ? Math.round((loopState.tokenUsage.input / loopState.maxTokens) * 100) / 100
              : 0,
          });
        }

        // 2. Handle text response - check for text-described tool calls
        const forceExecResult = this.messageProcessor.detectAndForceExecuteTextToolCall(response);
        if (forceExecResult.shouldContinue) continue;
        response = forceExecResult.response;
        const wasForceExecuted = forceExecResult.wasForceExecuted;

        // 2a-2. L3 空输出自动续接（doom loop 防护，带上限）：空文本既不该收尾也不该
        // 静默断流，注入续接提示让模型给出可用回答；连续超限则放行自然退出。
        if (
          response.type === 'text'
          && !response.content?.trim()
          && !this.ctx.forceFinalResponseReason
        ) {
          const emptyCheck = doomLoopGuard.recordEmptyOutput();
          if (emptyCheck.action === 'continue' && emptyCheck.nudge) {
            logger.warn('[DoomLoopGuard] Empty text output; auto-continuing with nudge');
            this.contextAssembly.injectSystemMessage(emptyCheck.nudge);
            continue;
          }
          logger.warn('[DoomLoopGuard] Empty output continuation limit reached; stopping');
        }

        // 2b. Handle actual text response
        if (response.type === 'text' && response.content) {
          const textAction = await this.messageProcessor.handleTextResponse(response, isSimpleTask, iterations, true, langfuse);
          if (textAction === 'continue') continue;
          if (this.ctx.goalMode?.isPending()) {
            this.contextAssembly.injectSystemMessage(this.ctx.goalMode.buildContinuationPrompt());
            continue;
          }
          if (textAction === 'break') break;
        }

        // 3. Handle tool calls
        if (response.type === 'tool_use' && response.toolCalls) {
          // Doom loop 防护：L1 同名同参 ×3 → 强警告；警告后仍重复 → 中止交还用户；
          // L2 整步行动签名 ×3 → nudge（不拒绝，让模型自己换策略）
          const doomCheck = doomLoopGuard.recordStep(
            response.toolCalls.map((tc) => ({ name: tc.name, arguments: tc.arguments })),
          );
          if (doomCheck.level === 'doom-loop-abort') {
            logger.warn('[DoomLoopGuard] Identical tool call repeated after warning; aborting run');
            logCollector.agent('WARN', 'Doom loop abort: identical tool call repeated after warning');
            this.ctx.onEvent({
              type: 'notification',
              data: { message: 'Doom loop 防护：模型连续重复同一工具调用且警告无效，已中止本次执行' },
            });
            terminal = { status: 'aborted' };
            break;
          }
          if (doomCheck.nudge) {
            logger.warn(`[DoomLoopGuard] ${doomCheck.level} detected; injecting nudge`);
            this.contextAssembly.injectSystemMessage(doomCheck.nudge);
          }
          const toolAction = await this.messageProcessor.handleToolResponse(response, wasForceExecuted, iterations, langfuse);
          if (toolAction === 'continue') continue;
        }

        // Goal mode（自治循环）：本轮模型已自然收尾（无更多工具调用），但 goal 仍 pending
        // → 不退出，注入续跑提示继续下一轮。闸3 兜底已在 loop 顶每轮先跑。
        // 注：attempt_completion 申请退出由 messageProcessor 拦截记录（增量3b）；闸1/闸2
        //     验证通过才 markMet（增量3c）。在此之前 goal 不会被标 met，刻意拒绝 Ralph
        //     式"模型自报完成即退出"。recordTurnProgress 于增量3e 接线。
        if (this.ctx.goalMode?.isPending()) {
          this.contextAssembly.injectSystemMessage(this.ctx.goalMode.buildContinuationPrompt());
          continue;
        }

        break;
      }

      await this.waitWhilePaused();

      if (this.ctx.isCancelled) {
        terminal = { status: 'cancelled' };
      } else if (this.ctx.isInterrupted) {
        terminal = { status: 'interrupted' };
      } else if (this.ctx.goalMode?.getStatus() === 'met') {
        // 闸1 验证通过 → markMet → loop 退出，收尾标 goal_met。
        // （闸3 兜底中止已在 loop 内直接 terminal = 'aborted'。）
        // 终态事件：目标达成（UI 展示"目标已完成"+停表）
        this.ctx.onEvent({
          type: 'goal_complete',
          data: {
            status: 'met',
            turns: iterations,
            tokensUsed: goalTokensUsedWithSwarm(this.ctx),
            // 到限放行（修复预算耗尽）：完成但验证未全过，UI 显示安静降级标识
            ...(this.ctx.goalMode.isVerificationDegraded()
              ? { degraded: true, degradedReason: this.ctx.goalMode.getDegradedReason() }
              : {}),
          },
        });
        terminal = { status: 'goal_met' };
      } else if (this.ctx.goalMode?.getStatus() === 'aborted' && terminal.status === 'completed') {
        // 闸内主动止损（如 IMPOSSIBLE）后 loop 自然退出：映射 aborted，
        // 不能让用户拿到一个看似 completed 的 run（goal_complete 事件已在闸内发出）
        terminal = { status: 'aborted' };
      }
    } catch (error) {
      terminal = { status: 'failed', error };
      runError = error;
      await persistFailedRunContinuationContext(this.contextAssembly, userMessage, iterations, error);
    } finally {
      // forced-final 是 per-run 语义：正常路径由 handleTextResponse 在产出最终
      // 文本后清理，但空输出/异常/cancel 等退出路径会绕过它——若不在此兜底清理，
      // flag 泄漏到下一次用户输入会让 inference 持续禁用全部工具（codex audit R2）。
      this.ctx.forceFinalResponseReason = undefined;
      this.ctx.forceFinalResponsePrompt = undefined;
      // G20: 先同步 flush turn trace —— 必须排在 await finalizeRun 之前。
      // finalizeRun 会发出 agent_complete 事件，CLI/host 收到后可能立即 process.exit，
      // 进程在那个 await 让出点被杀，排在其后的同步代码就永远执行不到。
      this.ctx.turnTrace.flush();
      await this.runFinalizer.finalizeRun(iterations, userMessage, langfuse, genNum, terminal);
      this.ctx.runAbortController = null;
    }

    if (runError) throw runError;
  }

  // ========================================================================
  // Initialization
  // ========================================================================

  async initializeRun(userMessage: string): Promise<{
    langfuse: ReturnType<typeof getLangfuseService>;
    isSimpleTask: boolean;
    genNum: number;
  } | null> {
    
    logger.debug('[AgentLoop] ========== run() START ==========');
    logger.debug('[AgentLoop] Message:', userMessage.substring(0, 100));

    logCollector.agent('INFO', `Agent run started: "${userMessage.substring(0, 200)}${userMessage.length > 200 ? '...' : ''}"`);
    logCollector.agent('DEBUG', `Model: ${this.ctx.modelConfig.provider}`);

    // Langfuse: Start trace
    const langfuse = getLangfuseService();
    this.ctx.traceId = `trace-${this.ctx.sessionId}-${Date.now()}`;
    this.ctx.currentTurnId = '';
    langfuse.startTrace(this.ctx.traceId, {
      sessionId: this.ctx.sessionId,
      userId: this.ctx.userId,
      modelProvider: this.ctx.modelConfig.provider,
      modelName: this.ctx.modelConfig.model,
      ...getDiagnosticVersions(),
    }, userMessage);

    await this.initializeUserHooks();

    this.ctx.activeSkillInvocation = undefined;
    this.ctx.activeSkillContextBlock = undefined;

    // Task Complexity Analysis
    const complexityAnalysis = taskComplexityAnalyzer.analyze(userMessage);
    let isSimpleTask = complexityAnalysis.complexity === 'simple';
    const startupTaskFeatures = detectTaskFeatures(userMessage);
    const isPureContentGenerationTask =
      startupTaskFeatures.isDocumentTask &&
      !startupTaskFeatures.isPPTTask &&
      !startupTaskFeatures.isDataTask &&
      !startupTaskFeatures.isExcelTask &&
      !startupTaskFeatures.isImageTask &&
      !startupTaskFeatures.isVideoTask &&
      !startupTaskFeatures.isMultiDimension &&
      !startupTaskFeatures.isAuditTask &&
      !startupTaskFeatures.isReviewTask &&
      !startupTaskFeatures.isPlanningTask &&
      !startupTaskFeatures.isFuzzyCodeReview &&
      !startupTaskFeatures.isFuzzyTroubleshooting;
    preloadToolsForIntent(startupTaskFeatures);
    try {
      const skillInvocation =
        await resolveSkillInvocation(userMessage, this.ctx.workingDirectory)
        ?? await resolveStickyStrictSkillInvocation(this.ctx, userMessage);
      if (skillInvocation) {
        const skillContext = await buildSkillInvocationContext(skillInvocation, this.ctx.workingDirectory);
        this.ctx.activeSkillInvocation = {
          skillName: skillInvocation.skill.name,
          source: skillInvocation.skill.source,
          basePath: skillInvocation.skill.basePath,
          matchKind: skillInvocation.matchKind,
          matchedText: skillInvocation.matchedText,
          aliases: skillInvocation.aliases,
          confidence: skillInvocation.confidence,
        };
        this.ctx.activeSkillContextBlock = skillContext.block;

        if (skillContext.contextModifier.preApprovedTools) {
          for (const tool of skillContext.contextModifier.preApprovedTools) {
            this.ctx.preApprovedTools.add(tool);
          }
        }
        // GAP-001: skill allowed-tools 限权边界
        if (skillContext.contextModifier.toolBoundary) {
          this.ctx.skillToolBoundary = skillContext.contextModifier.toolBoundary;
        }
        if (skillContext.contextModifier.modelOverride) {
          this.ctx.skillModelOverride = skillContext.contextModifier.modelOverride;
        }

        isSimpleTask = false;
        (this.ctx.antiPatternDetector as { markSemanticProgress?: (reason: string) => void })
          .markSemanticProgress?.(`skill invocation resolved: ${skillInvocation.skill.name}`);

        logger.info('[AgentLoop] Skill invocation resolved before intent classification', {
          skillName: skillInvocation.skill.name,
          matchKind: skillInvocation.matchKind,
          matchedText: skillInvocation.matchedText,
          confidence: skillInvocation.confidence,
        });
        logCollector.agent('INFO', `Skill invocation resolved: ${skillInvocation.skill.name}`, {
          matchKind: skillInvocation.matchKind,
          matchedText: skillInvocation.matchedText,
          confidence: skillInvocation.confidence,
        });
      }
    } catch (error) {
      logger.warn('[AgentLoop] Skill invocation resolution failed, continuing without required skill context', {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    this.ctx.isSimpleTaskMode = isSimpleTask;


    this.ctx.externalDataCallCount = 0;
    this.ctx.runStartTime = Date.now();
    this.ctx.totalIterations = 0;
    this.ctx.totalTokensUsed = 0;
    this.ctx.totalToolCallCount = 0;



    // F1: Goal Re-Injection
    this.ctx.goalTracker.initialize(userMessage);

    logger.debug(` Task complexity: ${complexityAnalysis.complexity} (${Math.round(complexityAnalysis.confidence * 100)}%)`);
    if ((complexityAnalysis.targetFiles || []).length > 0) {
      logger.debug(` Target files: ${(complexityAnalysis.targetFiles || []).join(', ')}`);
    }
    logCollector.agent('INFO', `Task complexity: ${complexityAnalysis.complexity}`, {
      confidence: complexityAnalysis.confidence,
      reasons: complexityAnalysis.reasons,
      fastPath: isSimpleTask,
      targetFiles: complexityAnalysis.targetFiles || [],
    });

    if (!isSimpleTask) {
      const complexityHint = taskComplexityAnalyzer.generateComplexityHint(complexityAnalysis);
      // 持久化到 system context，确保每轮推理都可见（而非注入消息历史后被淹没）
      this.contextAssembly.pushPersistentSystemContext(complexityHint);

      if (!hasActiveSessionTodos(this.ctx.sessionId)) {
        try {
          const sessionScopedPlanningService = this.ctx.planningService?.getPlanDirectory().includes(this.ctx.sessionId)
            ? this.ctx.planningService
            : undefined;
          if (this.ctx.planningService && !sessionScopedPlanningService) {
            queueRuntimeDiagnostic(this.ctx, '当前 run 的 planning service 未绑定本会话，先直接同步 session todos');
          }

          if (sessionScopedPlanningService) {
            await sessionScopedPlanningService.initialize();
            const existingPlan = sessionScopedPlanningService.plan.getCurrentPlan()
              ?? await sessionScopedPlanningService.plan.read();
            const hasActivePlan = existingPlan && !sessionScopedPlanningService.plan.isComplete();

            if (hasActivePlan && existingPlan) {
              const { todos: seededTodos } = advanceTodoStatus(todosFromPlan(existingPlan));
              setSessionTodos(this.ctx.sessionId, seededTodos);
              const taskSync = syncTodosToSessionTasks(this.ctx.sessionId, seededTodos);
              this.ctx.onEvent({ type: 'todo_update', data: seededTodos });
              this.ctx.onEvent({
                type: 'task_update',
                data: {
                  tasks: taskSync.tasks,
                  action: 'sync',
                  taskIds: [
                    ...taskSync.created.map((task) => task.id),
                    ...taskSync.updated.map((task) => task.id),
                  ],
                  source: 'planning_bootstrap',
                },
              });
              queueRuntimeDiagnostic(
                this.ctx,
                `已从当前计划同步 ${seededTodos.length} 条待办，右侧进度不再回退成工具活动`,
              );
            }
          }

        } catch (planBootstrapError) {
          logger.warn('[AgentLoop] Plan bootstrap failed', {
            error: planBootstrapError instanceof Error ? planBootstrapError.message : String(planBootstrapError),
          });
          queueRuntimeDiagnostic(
            this.ctx,
            `任务计划同步失败：${planBootstrapError instanceof Error ? planBootstrapError.message : 'unknown error'}`,
          );
        }
      }

      if (isPureContentGenerationTask) {
        logger.info('[AgentLoop] Skipping parallel judgment for pure content generation task', {
          complexity: complexityAnalysis.complexity,
        });
        queueRuntimeDiagnostic(this.ctx, '并行判断已跳过：当前更像内容生成任务，避免额外小模型噪音');
      } else {
        // Parallel Judgment via small model (Groq)
        try {
          const orchestrator = getTaskOrchestrator();
          const judgment = await orchestrator.judge(userMessage);

          if (judgment.shouldParallel && judgment.confidence >= 0.7) {
            const parallelHint = orchestrator.generateParallelHint(judgment);
            this.contextAssembly.pushPersistentSystemContext(parallelHint);

            logger.info('[AgentLoop] Parallel execution suggested', {
              dimensions: judgment.parallelDimensions,
              criticalPath: judgment.criticalPathLength,
              speedup: judgment.estimatedSpeedup,
            });
            logCollector.agent('INFO', 'Parallel execution suggested', {
              dimensions: judgment.suggestedDimensions,
              confidence: judgment.confidence,
            });
            queueRuntimeDiagnostic(
              this.ctx,
              `并行判断建议拆分执行：${judgment.parallelDimensions} 个维度，置信度 ${Math.round(judgment.confidence * 100)}%`,
            );
          } else {
            queueRuntimeDiagnostic(
              this.ctx,
              `并行判断保持串行：${judgment.reason}（置信度 ${Math.round(judgment.confidence * 100)}%）`,
            );
          }
        } catch (error) {
          logger.warn('[AgentLoop] Parallel judgment failed, continuing without hint', error);
          queueRuntimeDiagnostic(
            this.ctx,
            `并行判断降级：${error instanceof Error ? error.message : 'unknown error'}`,
          );
        }
      }
    }

    // LLM-based intent classification (for research routing)
    if (complexityAnalysis.complexity === 'simple' || complexityAnalysis.complexity === 'moderate') {
      try {
        const intent = await classifyIntent(userMessage, this.ctx.modelRouter);
        logger.info('Intent classified', { intent, message: userMessage.substring(0, 50) });

        if (intent === 'research') {
          // 研究模式 prompt 持久化到 system context
          this.contextAssembly.injectResearchModePrompt(userMessage);
        }
      } catch (error) {
        logger.warn('Intent classification failed, continuing with normal mode', { error: String(error) });
      }
    }

    // Dynamic Agent Mode Detection V2
    const genNum = 8;
    
    logger.info(`[AgentLoop] Checking dynamic mode for gen${genNum}`);
    if (genNum >= 3) {
      try {
        const dynamicResult = buildDynamicPromptV2(userMessage, {
          toolsUsedInTurn: this.ctx.toolsUsedInTurn,
          iterationCount: this.ctx.toolsUsedInTurn.length,
          hasError: false,
          maxReminderTokens: 1200,
          includeFewShot: genNum >= 4,
        });
        this.ctx.currentAgentMode = dynamicResult.mode;

        logger.info(`[AgentLoop] Dynamic mode detected: ${dynamicResult.mode}`, {
          features: dynamicResult.features,
          readOnly: dynamicResult.modeConfig.readOnly,
          remindersSelected: dynamicResult.reminderStats.deduplication.selected,
          tokensUsed: dynamicResult.tokensUsed,
        });
        logCollector.agent('INFO', `Dynamic mode: ${dynamicResult.mode}`, {
          readOnly: dynamicResult.modeConfig.readOnly,
          isMultiDimension: dynamicResult.features.isMultiDimension,
          reminderStats: dynamicResult.reminderStats,
        });

        if (dynamicResult.userMessage !== userMessage) {
          const reminder = dynamicResult.userMessage.substring(userMessage.length).trim();
          if (reminder) {
            logger.info(`[AgentLoop] Injecting mode reminder (${reminder.length} chars, ${dynamicResult.tokensUsed} tokens) to persistent context`);
            // 任务模式 reminder（含 DATA_PROCESSING 等）持久化到 system context
            this.contextAssembly.pushPersistentSystemContext(reminder);
          }
        }
      } catch (error) {
        logger.error('[AgentLoop] Dynamic mode detection failed:', error);
      }
    }

    // Step-by-step execution for models that need it
    if (this.ctx.stepByStepMode && !isSimpleTask) {
      const { steps, isMultiStep } = this.parseMultiStepTask(userMessage);
      if (isMultiStep) {
        logger.info(`[AgentLoop] Multi-step task detected (${steps.length} steps), using step-by-step mode`);
        await this.runStepByStep(userMessage, steps);
        return null;
      }
    }

    // User-configurable hooks: UserPromptSubmit
    if (this.ctx.hookManager) {
      const promptResult = await this.ctx.hookManager.triggerUserPromptSubmit(userMessage, this.ctx.sessionId);
      if (!promptResult.shouldProceed) {
        logger.info('[AgentLoop] User prompt blocked by hook', { message: promptResult.message });
        this.ctx.onEvent({
          type: 'notification',
          data: { message: promptResult.message || 'Prompt blocked by hook' },
        });
        return null;
      }
      if (promptResult.message) {
        this.contextAssembly.injectSystemMessage(`<user-prompt-hook>\n${promptResult.message}\n</user-prompt-hook>`);
      }
    }

    const isFirstUserTurn = isSessionFirstUserTurn(this.ctx.messages);

    // Record session start for usage tracking (Light Memory)
    if (isFirstUserTurn) {
      recordSessionStart(this.ctx.sessionId).catch(() => { /* non-critical */ });
    }

    // Session start hooks run once per chat session; per-turn hooks stay on UserPromptSubmit/PreToolUse/PostToolUse.
    if (isFirstUserTurn && this.ctx.hookManager) {
      const sessionResult = await this.ctx.hookManager.triggerSessionStart(this.ctx.sessionId);
      if (sessionResult.message) {
        this.contextAssembly.injectSystemMessage(`<session-start-hook>\n${sessionResult.message}\n</session-start-hook>`);
      }
      if (sessionResult.injectedContext) {
        this.contextAssembly.injectSystemMessage(`<session-start-hook>\n${sessionResult.injectedContext}\n</session-start-hook>`);
      }
    }

    // F5: 跨会话任务恢复
    if (!isSimpleTask) {
      try {
        const recovery = await getSessionRecoveryService().checkPreviousSession(
          this.ctx.sessionId,
          this.ctx.workingDirectory
        );
        if (recovery) {
          this.contextAssembly.injectSystemMessage(`<session-recovery>\n${recovery}\n</session-recovery>`);
          logger.info('[AgentLoop] Session recovery summary injected');
        }
      } catch {
        // Graceful: recovery failure doesn't block execution
      }
    }

    await injectSeedMemory(this.ctx, this.contextAssembly, userMessage);

    await this.injectActivityContext({ includeDesktopActivity: !isSimpleTask });

    if (!isSimpleTask) {
      try {
        await this.bootstrapDesktopDerivedContext(userMessage);
      } catch (error) {
        // Graceful: desktop-derived 上下文（todos/task sync）依赖 DB，DB 未初始化或瞬时不可用时
        // 绝不能阻断整个 run（与 injectActivityContext / 会话恢复 / seed memory 同款降级）。
        logger.warn('[AgentLoop] Desktop-derived context bootstrap failed, continuing', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return { langfuse, isSimpleTask, genNum };
  }

  // ========================================================================
  // Control methods (cancel, interrupt, steer)
  // ========================================================================

  async cancel(reason?: 'user' | 'session-switch'): Promise<void> {
    this.ctx.isCancelled = true;

    // Preserve partial streaming content before aborting
    if (this.ctx.lastStreamedContent) {
      const suffix = reason === 'session-switch'
        ? '\n\n[未完成 — 切换会话中断]'
        : '\n\n[cancelled]';
      const partialMessage: Message = {
        id: generateMessageId(),
        role: 'assistant',
        content: this.ctx.lastStreamedContent + suffix,
        timestamp: Date.now(),
      };
      this.ctx.messages.push(partialMessage);
      // 必须 await — abort 触发后 inference Promise 立刻 reject，post-inference
      // persist 路径不会再走，partial 必须在 abort 前落 DB
      try {
        await this.ctx.persistMessage?.(partialMessage);
      } catch (err) {
        logger.warn('[ConversationRuntime] persist partial on cancel failed:', err);
      }
      this.ctx.lastStreamedContent = '';
    }
    this.ctx.abortController?.abort();
    this.ctx.runAbortController?.abort();
    this.releasePauseWaiters();
  }

  pause(): void {
    this.ctx.isPaused = true;
    logger.info('[ConversationRuntime] Paused');
  }

  resume(): void {
    this.ctx.isPaused = false;
    this.releasePauseWaiters();
    logger.info('[ConversationRuntime] Resumed');
  }

  interrupt(newMessage: string): void {
    this.ctx.isInterrupted = true;
    this.ctx.interruptMessage = newMessage;
    this.ctx.abortController?.abort();
    this.ctx.runAbortController?.abort();
    this.releasePauseWaiters();
    logger.info('[AgentLoop] Interrupt requested with new message');
  }

  steer(
    newMessage: string,
    clientMessageId?: string,
    attachments?: MessageAttachment[],
    metadata?: MessageMetadata,
  ): void {
    this.ctx.abortController?.abort();
    this.messageProcessor.injectSteerMessage(newMessage, clientMessageId, attachments, metadata);
    this.ctx.needsReinference = true;
    logger.info('[AgentLoop] Steer requested — message injected, will re-infer on next cycle');
  }

  wasInterrupted(): boolean {
    return this.ctx.isInterrupted;
  }

  getInterruptMessage(): string | null {
    return this.ctx.interruptMessage;
  }

  isRunning(): boolean {
    return !this.ctx.isCancelled && !this.ctx.isInterrupted;
  }

  getPlanningService(): PlanningService | undefined {
    return this.ctx.planningService;
  }

  setEffortLevel(level: import('../../../shared/contract/agent').EffortLevel): void {
    this.ctx.effortLevel = level;
    this.ctx.thinkingStepCount = 0;
    logger.debug(`[AgentLoop] Effort level set to: ${level}`);
  }

  setThinkingEnabled(enabled: boolean): void {
    this.ctx.thinkingEnabled = enabled;
    this.ctx.thinkingStepCount = 0;
    logger.debug(`[AgentLoop] Thinking ${enabled ? 'enabled' : 'disabled'}`);
  }

  getEffortLevel(): import('../../../shared/contract/agent').EffortLevel {
    return this.ctx.effortLevel;
  }

  setInteractionMode(mode: import('../../../shared/contract/agent').InteractionMode): void {
    this.ctx.interactionMode = mode;
    logger.debug(`[AgentLoop] Interaction mode set to: ${mode}`);
  }

  generateAutoContinuationPrompt(): string {
    return buildAutoContinuationPrompt();
  }
}
