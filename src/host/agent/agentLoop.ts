// ============================================================================
// Agent Loop - Core event loop for AI agent execution
// Enhanced with Manus-style persistent planning hooks
// ============================================================================

import type {
  ModelConfig,
  Message,
  MessageAttachment,
  MessageMetadata,
  ToolCall,
  ToolResult,
  AgentEvent,
  AgentTaskPhase,
} from '../../shared/contract';
import type { StructuredOutputConfig, StructuredOutputResult } from './structuredOutput';
import { parseStructuredOutput, generateFormatCorrectionPrompt } from './structuredOutput';
import type { ToolExecutor } from '../tools/toolExecutor';
import { getToolSearchService } from '../services/toolSearch';
import { ModelRouter, ContextLengthExceededError } from '../model/modelRouter';
import type { PlanningService } from '../planning';
import { getConfigService, getAuthService, getLangfuseService, getBudgetService, BudgetAlertLevel, getSessionManager } from '../services';
import { logCollector } from '../mcp/logCollector.js';
import { generateMessageId } from '../../shared/utils/id';
import { taskComplexityAnalyzer } from '../planning/taskComplexityAnalyzer';
import { classifyIntent } from '../routing/intentClassifier';
import { getTaskOrchestrator } from '../planning/taskOrchestrator';
import { getMaxIterations } from '../services/cloud/featureFlagService';
import { createLogger } from '../services/infra/logger';
import { HookManager, createHookManager } from '../hooks';
import type { BudgetEventData } from '../../shared/contract';
import { getContextHealthService } from '../context/contextHealthService';
import { getSystemPromptCache } from '../telemetry/systemPromptCache';
import { DEFAULT_MODELS, MAX_MODE, MODEL_MAX_TOKENS, getContextWindow, TOOL_PROGRESS, TOOL_TIMEOUT_THRESHOLDS } from '../../shared/constants';

// Import refactored modules
import type {
  AgentLoopConfig,
  ModelResponse,
  ModelMessage,
} from './loopTypes';
import { isParallelSafeTool, classifyToolCalls } from './toolExecution/parallelStrategy';
import { CircuitBreaker } from './toolExecution/circuitBreaker';
import { classifyExecutionPhase } from '../tools/executionPhase';
import {
  formatToolCallForHistory,
  sanitizeToolResultsForHistory,
  buildMultimodalContent,
  stripImagesFromMessages,
  extractUserRequestText,
} from './messageHandling/converter';
import {
  injectWorkingDirectoryContext,
  buildEnhancedSystemPrompt,
  buildRuntimeModeBlock,
} from './messageHandling/contextBuilder';
import { getPromptForTask, buildDynamicPromptV2, type AgentMode } from '../prompts/builder';
import type { PromptProfile } from '../prompts/profiles';
import { AntiPatternDetector } from './antiPattern/detector';
import { cleanXmlResidues } from './antiPattern/cleanXml';
import { GoalTracker } from './goalTracker';
import { GoalModeController } from './goalModeController';
import { resolveScaffoldProfileForModel } from './runtime/scaffoldProfile';
import { NudgeManager } from './nudgeManager';
import { getSessionRecoveryService } from './sessionRecovery';
import { getIncompleteTasks } from '../services/planning/taskStore';
import {
  parseTodos,
  mergeTodos,
  advanceTodoStatus,
  completeCurrentAndAdvance,
  getSessionTodos,
  setSessionTodos,
  clearSessionTodos,
} from './todoParser';
import { fileReadTracker } from '../tools/fileReadTracker';
import { dataFingerprintStore } from '../tools/dataFingerprint';
import { MAX_PARALLEL_TOOLS } from './loopTypes';
import {
  compressToolResult,
  HookMessageBuffer,
  estimateModelMessageTokens,
  MessageHistoryCompressor,
  estimateTokens,
} from '../context/tokenOptimizer';
import { AutoContextCompressor, getAutoCompressor } from '../context/autoCompressor';
import { CompressionState } from '../context/compressionState';
import { CompressionPipeline } from '../context/compressionPipeline';

import { getInputSanitizer } from '../security/inputSanitizer';
import { getDiffTracker } from '../services/diff/diffTracker';
import { getCitationService } from '../services/citation/citationService';
import { existsSync, readdirSync, readFileSync } from 'fs';
import { join, basename } from 'path';
import { createHash } from 'crypto';

import { analyzeTask } from './hybrid/taskRouter';

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
import type { RuntimeContext } from './runtime/runtimeContext';
import { ConversationRuntime } from './runtime/conversationRuntime';
import { ToolExecutionEngine } from './runtime/toolExecutionEngine';
import { ContextAssembly } from './runtime/contextAssembly';
import { RunFinalizer } from './runtime/runFinalizer';
import { LearningPipeline } from './runtime/learningPipeline';
import { loadPersistedRuntimeState } from './runtime/runtimeStatePersistence';
import { TurnTraceRecorder } from './runtime/turnTrace';
import { TurnState } from './runtime/turnState';
import { ControlState } from './runtime/controlState';
import { ContextHealthState } from './runtime/contextHealthState';
import { RunStatsState } from './runtime/runStatsState';
import { ArtifactState } from './runtime/artifactState';
import { createTelemetryAdapter } from '../telemetry/telemetryAdapter';
import { composeTelemetryAdapters } from './metricsCollector';
import { withRunTraceContext } from '../telemetry/runTraceContext';

export class AgentLoop {
  private ctx: RuntimeContext;
  private conversationRuntime: ConversationRuntime;
  private toolEngine: ToolExecutionEngine;
  private contextAssembly: ContextAssembly;
  private runFinalizer: RunFinalizer;
  private learningPipeline: LearningPipeline;
  private promptProfile: PromptProfile = 'interactive';

  constructor(config: AgentLoopConfig) {
    const contextWindow = getContextWindow(config.modelConfig.model);
    const lightCompressionThreshold = Math.max(8000, Math.round(contextWindow * 0.50));
    // B7：按模型能力档解析脚手架厚度（flag 关 / 未标注模型 = standard = 现状行为）
    const scaffoldProfile = resolveScaffoldProfileForModel(config.modelConfig.model);
    if (scaffoldProfile.tier !== 'standard') {
      // 臂激活记号：profile 真生效时必须留痕（A3 疫苗——防"开关开了接线没走到"）
      logger.info(`[AgentLoop] scaffold-profile-active tier=${scaffoldProfile.tier} model=${config.modelConfig.model}`);
    }
    const resolvedSessionId = config.sessionId || `session-${Date.now()}`;
    const persistedRuntimeState = loadPersistedRuntimeState(resolvedSessionId);
    let compressionState = new CompressionState();
    if (persistedRuntimeState?.compressionStateJson) {
      try {
        compressionState = CompressionState.deserialize(persistedRuntimeState.compressionStateJson);
      } catch (err) {
        logger.warn('[AgentLoop] Failed to restore persisted compression state', err);
      }
    }

    this.ctx = {
      systemPrompt: config.systemPrompt || '',
      modelConfig: config.modelConfig,
      toolExecutor: config.toolExecutor,
      messages: config.messages,
      onEvent: config.onEvent,
      modelRouter: new ModelRouter(),
      // Goal 模式：轮次上限用契约的 maxTurns（通常 > 默认 30），否则走默认
      maxIterations: config.maxIterations ?? config.goalContract?.maxTurns ?? getMaxIterations(),
      workingDirectory: config.workingDirectory,
      isDefaultWorkingDirectory: config.isDefaultWorkingDirectory ?? true,
      // Every loop needs a stable execution identity even on legacy desktop
      // entry points that have not adopted RunRegistry yet.
      runId: config.runId || `run-${generateMessageId()}`,
      runTraceContext: config.runTraceContext,
      sessionId: resolvedSessionId,
      agentId: config.agentId,
      agentName: config.agentName,
      requestedAgentId: config.requestedAgentId,
      userId: config.userId,
      memoryMode: config.memoryMode ?? 'auto',
      suppressedMemoryEntryIds: config.suppressedMemoryEntryIds,
      persistMessage: config.persistMessage,
      onToolExecutionLog: config.onToolExecutionLog,
      toolScope: config.toolScope,
      executionIntent: config.executionIntent,
      neoTag: config.neoTag,

      // Services
      circuitBreaker: new CircuitBreaker(),
      antiPatternDetector: new AntiPatternDetector(),
      goalTracker: new GoalTracker(),
      // Goal 模式控制器：契约存在才激活（opt-in），否则 undefined（普通 run 不走 goal 分支）
      goalMode: config.goalContract
        ? new GoalModeController(config.goalContract, {
            auditIntervalMultiplier: scaffoldProfile.auditNudgeIntervalMultiplier,
          })
        : undefined,
      nudgeManager: new NudgeManager(),
      hookManager: config.hookManager,
      planningService: config.planningService,
      inferenceOptions: config.inferenceOptions,
      historyVisibility: config.historyVisibility,
      deniedToolNames: config.deniedToolNames,
      hookMessageBuffer: new HookMessageBuffer(),
      messageHistoryCompressor: new MessageHistoryCompressor({
        threshold: lightCompressionThreshold,
        targetTokens: Math.round(lightCompressionThreshold * 0.5),
        preserveRecentCount: 6,
        preserveUserMessages: true,
      }),
      autoCompressor: getAutoCompressor(),
      compressionPipeline: new CompressionPipeline(),
      telemetryAdapter: config.telemetryAdapter
        ? composeTelemetryAdapters(config.telemetryAdapter, createTelemetryAdapter())
        : createTelemetryAdapter(),

      // Turn 级状态切片（ADR-038 批3a）
      turn: new TurnState(),
      // 控制流状态切片（ADR-038 批3b）
      control: new ControlState(),
      // RunStats+Tracing 切片（ADR-038 批3d）
      stats: new RunStatsState(),
      // Artifact 状态切片（ADR-038 批3e）
      artifact: new ArtifactState(),

      // Plan mode
      autoApprovePlan: config.autoApprovePlan ?? false,

      // Hooks
      enableHooks: config.enableHooks ?? true,
      maxStopHookRetries: 3,
      enableDeliveryCritic: config.enableDeliveryCritic ?? process.env.CODE_AGENT_DELIVERY_CRITIC === '1',
      // Max Mode（best-of-N）显式开关，默认关——eval 对照前提 + 出问题的回滚通道
      maxMode: config.maxMode ?? process.env.CODE_AGENT_MAX_MODE === '1',
      maxModeCandidates: config.maxModeCandidates ?? MAX_MODE.DEFAULT_CANDIDATES,

      // Tool execution
      maxToolCallRetries: 2,
      enableToolDeferredLoading: config.enableToolDeferredLoading ?? true,

      // Structured output
      maxStructuredOutputRetries: 2,

      // Step-by-step
      stepByStepMode: config.stepByStepMode ?? false,

      // Tracing
      turnTrace: new TurnTraceRecorder(resolvedSessionId),
      turnQualityState: {},
      goalEvidenceState: { bounces: 0 },

      // Budget
      consecutiveErrors: 0,

      // Thinking
      scaffoldProfile,

      // Task stats

      // Context recovery
      MAX_CONSECUTIVE_TRUNCATIONS: 3,
      MAX_CONSECUTIVE_COMPACTS: 2,

      // Context health（ADR-038 批3c）
      contextHealth: new ContextHealthState({
        compressionState,
        persistentSystemContext: persistedRuntimeState?.persistentSystemContext ?? [],
      }),
    };

    // Create modules
    this.conversationRuntime = new ConversationRuntime(this.ctx, config.structuredOutput);
    this.toolEngine = new ToolExecutionEngine(this.ctx);
    this.contextAssembly = new ContextAssembly(this.ctx);
    this.runFinalizer = new RunFinalizer(this.ctx);
    this.learningPipeline = new LearningPipeline(this.ctx);

    // Wire cross-module references
    this.conversationRuntime.setModules(
      this.toolEngine,
      this.contextAssembly,
      this.runFinalizer,
      this.learningPipeline,
    );
    this.runFinalizer.setModules(this.contextAssembly, this.learningPipeline);
    this.toolEngine.setModules(this.contextAssembly, this.runFinalizer, this.conversationRuntime);
    this.contextAssembly.setModules(this.runFinalizer);
  }

  // ========== Public API — all delegated ==========

  getPromptProfile(): PromptProfile {
    return this.promptProfile;
  }

  async run(userMessage: string): Promise<void> {
    // 每条 user 消息开新的工具 repair 失败统计窗口（Kimi 借鉴 #1）
    this.toolEngine.resetRepairGate();
    if (this.ctx.runTraceContext) {
      return withRunTraceContext(
        this.ctx.runTraceContext,
        () => this.conversationRuntime.run(userMessage),
      );
    }
    return this.conversationRuntime.run(userMessage);
  }

  setPlanMode(active: boolean): void {
    this.conversationRuntime.setPlanMode(active);
  }

  isPlanMode(): boolean {
    return this.conversationRuntime.isPlanMode();
  }

  setStructuredOutput(config: StructuredOutputConfig | undefined): void {
    this.conversationRuntime.setStructuredOutput(config);
  }

  getStructuredOutput(): StructuredOutputConfig | undefined {
    return this.conversationRuntime.getStructuredOutput();
  }

  setEffortLevel(level: import('../../shared/contract/agent').EffortLevel): void {
    this.conversationRuntime.setEffortLevel(level);
  }

  setThinkingEnabled(enabled: boolean): void {
    this.conversationRuntime.setThinkingEnabled(enabled);
  }

  getEffortLevel(): import('../../shared/contract/agent').EffortLevel {
    return this.conversationRuntime.getEffortLevel();
  }

  setInteractionMode(mode: import('../../shared/contract/agent').InteractionMode): void {
    this.conversationRuntime.setInteractionMode(mode);
  }

  async cancel(reason?: 'user' | 'session-switch'): Promise<void> {
    await this.conversationRuntime.cancel(reason);
  }

  pause(): void {
    this.conversationRuntime.pause();
  }

  resume(): void {
    this.conversationRuntime.resume();
  }

  interrupt(newMessage: string): void {
    this.conversationRuntime.interrupt(newMessage);
  }

  async steer(
    newMessage: string,
    clientMessageId?: string,
    attachments?: MessageAttachment[],
    metadata?: MessageMetadata,
  ): Promise<void> {
    await this.conversationRuntime.steer(newMessage, clientMessageId, attachments, metadata);
  }

  wasInterrupted(): boolean {
    return this.conversationRuntime.wasInterrupted();
  }

  getInterruptMessage(): string | null {
    return this.conversationRuntime.getInterruptMessage();
  }

  isRunning(): boolean {
    return this.conversationRuntime.isRunning();
  }

  getPlanningService(): PlanningService | undefined {
    return this.conversationRuntime.getPlanningService();
  }

  getHookManager(): HookManager | undefined {
    return this.ctx.hookManager;
  }

  getSerializedCompressionState(): string {
    return this.ctx.contextHealth.compressionState.serialize();
  }
}
