// ============================================================================
// Agent Loop - Core event loop for AI agent execution
// Enhanced with Manus-style persistent planning hooks
// ============================================================================

import type {
  ModelConfig,
  Message,
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
import { DEFAULT_MODELS, MODEL_MAX_TOKENS, getContextWindow, TOOL_PROGRESS, TOOL_TIMEOUT_THRESHOLDS } from '../../shared/constants';

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

    this.ctx = {
      systemPrompt: config.systemPrompt || '',
      modelConfig: config.modelConfig,
      toolExecutor: config.toolExecutor,
      messages: config.messages,
      onEvent: config.onEvent,
      modelRouter: new ModelRouter(),
      maxIterations: getMaxIterations(),
      workingDirectory: config.workingDirectory,
      isDefaultWorkingDirectory: config.isDefaultWorkingDirectory ?? true,
      sessionId: config.sessionId || `session-${Date.now()}`,
      agentId: config.agentId,
      userId: config.userId,
      persistMessage: config.persistMessage,
      onToolExecutionLog: config.onToolExecutionLog,
      toolScope: config.toolScope,
      executionIntent: config.executionIntent,

      // Services
      circuitBreaker: new CircuitBreaker(),
      antiPatternDetector: new AntiPatternDetector(),
      goalTracker: new GoalTracker(),
      nudgeManager: new NudgeManager(),
      hookManager: config.hookManager,
      planningService: config.planningService,
      hookMessageBuffer: new HookMessageBuffer(),
      messageHistoryCompressor: new MessageHistoryCompressor({
        threshold: lightCompressionThreshold,
        targetTokens: Math.round(lightCompressionThreshold * 0.5),
        preserveRecentCount: 6,
        preserveUserMessages: true,
      }),
      autoCompressor: getAutoCompressor(),
      compressionState: new CompressionState(),
      compressionPipeline: new CompressionPipeline(),
      telemetryAdapter: config.telemetryAdapter,

      // Mutable state
      lastStreamedContent: '',
      isCancelled: false,
      _isRunning: false,
      isInterrupted: false,
      isPaused: false,
      interruptMessage: null,
      needsReinference: false,
      abortController: null,

      // Plan mode
      isPlanModeActive: false,
      planModeActive: false,
      savedMessages: null,
      currentAgentMode: 'normal',
      autoApprovePlan: config.autoApprovePlan ?? false,

      // Hooks
      enableHooks: config.enableHooks ?? true,
      userHooksInitialized: false,
      stopHookRetryCount: 0,
      maxStopHookRetries: 3,

      // Tool execution
      toolCallRetryCount: 0,
      maxToolCallRetries: 2,
      externalDataCallCount: 0,
      preApprovedTools: new Set(),
      enableToolDeferredLoading: config.enableToolDeferredLoading ?? true,

      // Structured output
      structuredOutput: config.structuredOutput,
      structuredOutputRetryCount: 0,
      maxStructuredOutputRetries: 2,

      // Step-by-step
      stepByStepMode: config.stepByStepMode ?? false,

      // Tracing
      traceId: '',
      currentIterationSpanId: '',
      currentTurnId: '',

      // Turn tracking
      turnStartTime: 0,
      toolsUsedInTurn: [],
      isSimpleTaskMode: false,

      // Research mode
      _researchModeActive: false,
      _researchIterationCount: 0,
      researchModeInjected: false,

      // Budget
      budgetWarningEmitted: false,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      consecutiveErrors: 0,

      // Thinking
      effortLevel: 'high' as any,
      thinkingStepCount: 0,

      // Interaction mode
      interactionMode: 'code' as any,

      // Persistent system context
      persistentSystemContext: [],

      // Task stats
      runStartTime: 0,
      totalIterations: 0,
      totalTokensUsed: 0,
      totalToolCallCount: 0,

      // Context recovery
      _contextOverflowRetried: false,
      _truncationRetried: false,
      _networkRetried: false,
      _consecutiveTruncations: 0,
      MAX_CONSECUTIVE_TRUNCATIONS: 3,

      // Content verification
      contentVerificationRetries: new Map(),

      // Context health
      contextHealthy: true,
      autoCompressThreshold: 0,
      contextBudgetRatio: 0,
      genNum: 8,
      initialSystemPromptLength: 0,
    };

    // Create modules
    this.conversationRuntime = new ConversationRuntime(this.ctx);
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

  getEffortLevel(): import('../../shared/contract/agent').EffortLevel {
    return this.conversationRuntime.getEffortLevel();
  }

  setInteractionMode(mode: import('../../shared/contract/agent').InteractionMode): void {
    this.conversationRuntime.setInteractionMode(mode);
  }

  cancel(): void {
    this.conversationRuntime.cancel();
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

  steer(newMessage: string): void {
    this.conversationRuntime.steer(newMessage);
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
    return this.ctx.compressionState.serialize();
  }
}
