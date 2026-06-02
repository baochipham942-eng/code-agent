// ============================================================================
// RuntimeContext — Shared mutable state for all runtime modules
// ============================================================================

import type {
  Message,
  AgentEvent,
  ToolResult,
} from '../../../shared/contract';
import type { StructuredOutputConfig } from '../structuredOutput';
import type { EffortLevel, InteractionMode } from '../../../shared/contract/agent';
import type { ModelConfig } from '../../../shared/contract/model';
import type { ToolExecutor } from '../../tools/toolExecutor';
import type { ModelRouter } from '../../model/modelRouter';
import type { CircuitBreaker } from '../toolExecution/circuitBreaker';
import type { AntiPatternDetector } from '../antiPattern/detector';
import type { GoalTracker } from '../goalTracker';
import type { GoalModeController } from '../goalModeController';
import type { NudgeManager } from '../nudgeManager';
import type { HookManager } from '../../hooks/hookManager';
import type { PlanningService } from '../../planning/planningService';
import type { HookMessageBuffer, MessageHistoryCompressor } from '../../context/tokenOptimizer';
import type { AutoContextCompressor } from '../../context/autoCompressor';
import type { CompressionState } from '../../context/compressionState';
import type { CompressionPipeline } from '../../context/compressionPipeline';
import type { TelemetryAdapter } from '../../../shared/contract/telemetry';
import type { InferenceOptions } from '../../model/types';
import type {
  ConversationExecutionIntent,
  WorkbenchToolScope,
} from '../../../shared/contract/conversationEnvelope';
import type { SkillInvocationMatchKind } from '../../services/skills/skillInvocationResolver';
import type { SkillToolBoundary } from '../../../shared/contract/agentSkill';
import type { TurnTraceRecorder } from './turnTrace';

/**
 * Mutable shared state. Single object, all modules share the same reference.
 * All service types are strongly typed via `import type` (no runtime circular deps).
 */
export interface RuntimeContext {
  // --- Configuration ---
  systemPrompt: string;
  modelConfig: ModelConfig;
  toolExecutor: ToolExecutor;
  messages: Message[];
  onEvent: (event: AgentEvent) => void;
  modelRouter: ModelRouter;
  maxIterations: number;
  workingDirectory: string;
  isDefaultWorkingDirectory: boolean;
  sessionId: string;
  agentId?: string;
  userId?: string;
  persistMessage?: (message: Message) => Promise<void>;
  onToolExecutionLog?: (log: { sessionId: string; toolCallId: string; toolName: string; args: Record<string, unknown>; result: ToolResult }) => void;
  toolScope?: WorkbenchToolScope;
  executionIntent?: ConversationExecutionIntent;

  // --- Services / modules ---
  circuitBreaker: CircuitBreaker;
  antiPatternDetector: AntiPatternDetector;
  goalTracker: GoalTracker;
  /** /goal 自治循环控制器；仅 goal 模式下存在（opt-in），普通 run 为 undefined */
  goalMode?: GoalModeController;
  nudgeManager: NudgeManager;
  hookManager?: HookManager;
  planningService?: PlanningService;
  contentVerifier?: unknown;
  hookMessageBuffer: HookMessageBuffer;
  messageHistoryCompressor: MessageHistoryCompressor;
  autoCompressor: AutoContextCompressor;
  compressionState: CompressionState;
  compressionPipeline: CompressionPipeline;
  telemetryAdapter?: TelemetryAdapter;
  inferenceOptions?: InferenceOptions;

  // --- Mutable run state ---
  lastStreamedContent: string;
  isCancelled: boolean;
  isInterrupted: boolean;
  isPaused: boolean;
  interruptMessage: string | null;
  needsReinference: boolean;
  abortController: AbortController | null;
  runAbortController: AbortController | null;

  // --- Plan mode ---
  isPlanModeActive: boolean;
  planModeActive: boolean;
  savedMessages: Message[] | null;
  currentAgentMode: string;
  autoApprovePlan: boolean;

  // --- Hooks ---
  enableHooks: boolean;
  userHooksInitialized: boolean;
  stopHookRetryCount: number;
  maxStopHookRetries: number;
  /** GAP-006: 用户 Stop hook block 触发的重试计数（独立于 planning stop hook 计数） */
  userStopHookBlockCount: number;
  /** GAP-013: Generator-Critic 交付前自动验证开关 */
  enableDeliveryCritic: boolean;
  /** GAP-013: 本 run 是否已跑过交付前 critic（每 run 最多一次，防死循环） */
  deliveryCriticRan: boolean;
  userHooks?: unknown;

  // --- Tool execution ---
  toolCallRetryCount: number;
  maxToolCallRetries: number;
  externalDataCallCount: number;
  preApprovedTools: Set<string>;
  /** GAP-001: 当前激活 skill 的 allowed-tools 限权边界（边界外的工具调用强制用户审批） */
  skillToolBoundary?: SkillToolBoundary;
  skillModelOverride?: string;
  enableToolDeferredLoading: boolean;

  // --- Structured output ---
  structuredOutput?: StructuredOutputConfig;
  structuredOutputRetryCount: number;
  maxStructuredOutputRetries: number;

  // --- Step-by-step ---
  stepByStepMode: boolean;

  // --- Tracing ---
  traceId: string;
  currentIterationSpanId: string;
  currentTurnId: string;
  messageDeltaSeq: number;
  currentSystemPromptHash?: string;
  /** G20: per-run 结构化 turn trace（决策 / dispatch / compaction） */
  turnTrace: TurnTraceRecorder;
  pendingRuntimeDiagnostics: string[];
  /** GAP-023: 当前生效 system prompt 构建时被预算丢弃/裁剪的块（可见化到 context health） */
  droppedPromptBlocks?: string[];
  forceFinalResponseReason?: string;
  forceFinalResponsePrompt?: string;
  /** Last interactive artifact path that passed runtime/browser validation in this run. */
  artifactValidationPassedTargetFile?: string;
  activeSkillInvocation?: {
    skillName: string;
    source: string;
    basePath: string;
    matchKind: SkillInvocationMatchKind;
    matchedText: string;
    aliases: string[];
    confidence: number;
  };
  activeSkillContextBlock?: string;
  artifactRepairGuard?: {
    targetFile: string;
    attempts: number;
    phase: string;
    // Route A loop guard: repair turns since the last successful target-file
    // mutation. Reaching ARTIFACT_REPAIR_MAX_ATTEMPTS force-stops the repair turn.
    repairTurnsWithoutProgress?: number;
    lastBlockedTool?: string;
    patched?: boolean;
    lastFailedPatchFingerprint?: string;
    activeIssueCodes?: string[];
  };

  // --- Turn tracking ---
  turnStartTime: number;
  toolsUsedInTurn: string[];
  isSimpleTaskMode: boolean;

  // --- Research mode ---
  _researchModeActive: boolean;
  _researchIterationCount: number;
  researchModeInjected: boolean;

  // --- Budget ---
  budgetWarningEmitted: boolean;
  totalInputTokens: number;
  totalOutputTokens: number;
  consecutiveErrors: number;

  // --- Stagnation detection ---
  // 最近 N 次工具调用的 fingerprint (name + args_hash + result_hash)。
  // 连续 STAGNATION_THRESHOLD 个相同 → 注入 system 提示并 break，避免死循环。
  recentToolFingerprints: string[];
  stagnationWarningEmitted: boolean;

  // --- Ground-truth gate ---
  // 本次 run 中 tool result 命中反爬指纹的次数。finalize 时如果用户消息含 URL
  // 且此计数 >= 阈值，给最终 assistant_response 加一个 disclaimer，避免幻觉伪造
  // 内容被当成"成功获取"上交。
  antiScrapingHitsInRun: number;

  // --- Thinking ---
  effortLevel: EffortLevel;
  thinkingEnabled: boolean;
  thinkingStepCount: number;

  // --- Interaction mode ---
  interactionMode: InteractionMode;

  // --- Task stats ---
  runStartTime: number;
  totalIterations: number;
  totalTokensUsed: number;
  totalToolCallCount: number;

  // --- Context recovery ---
  _contextOverflowRetried: boolean;
  _truncationRetried: boolean;
  _artifactNonStreamingRetried: boolean;
  _artifactRepairCompactWriteRetried: boolean;
  _networkRetried: boolean;
  _networkRetryCount?: number;
  _consecutiveTruncations: number;
  MAX_CONSECUTIVE_TRUNCATIONS: number;

  // --- Content verification ---
  contentVerificationRetries: Map<string, number>;

  // --- Persistent system context ---
  // 任务指导类信息（复杂度提示、并行建议、任务模式 reminder 等）
  // 存在此处而非 ctx.messages，确保每轮推理都作为 system prompt 的一部分可见
  persistentSystemContext: string[];

  // --- Context health ---
  contextHealthy: boolean;
  autoCompressThreshold: number;
  contextBudgetRatio: number;
  genNum: number;
  initialSystemPromptLength: number;
  /** G12/P2-full: 本 turn CompressionPipeline 是否报了 autocompact-needed。
   *  由 messageBuild 写入，checkAndAutoCompress 经 ContextPressureController 消费后清零。 */
  pipelineAutocompactNeeded: boolean;
}
