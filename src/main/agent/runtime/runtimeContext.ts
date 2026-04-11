// ============================================================================
// RuntimeContext — Shared mutable state for all runtime modules
// ============================================================================

import type {
  Message,
  AgentEvent,
  ToolResult,
} from '../../../shared/types';
import type { StructuredOutputConfig } from '../structuredOutput';
import type { EffortLevel, InteractionMode } from '../../../shared/types/agent';
import type { ModelConfig } from '../../../shared/types/model';
import type { ToolRegistryLike } from '../../tools/types';
import type { ToolExecutor } from '../../tools/toolExecutor';
import type { ModelRouter } from '../../model/modelRouter';
import type { CircuitBreaker } from '../toolExecution/circuitBreaker';
import type { AntiPatternDetector } from '../antiPattern/detector';
import type { GoalTracker } from '../goalTracker';
import type { NudgeManager } from '../nudgeManager';
import type { HookManager } from '../../hooks/hookManager';
import type { PlanningService } from '../../planning/planningService';
import type { HookMessageBuffer, MessageHistoryCompressor } from '../../context/tokenOptimizer';
import type { AutoContextCompressor } from '../../context/autoCompressor';
import type { CompressionState } from '../../context/compressionState';
import type { CompressionPipeline } from '../../context/compressionPipeline';
import type { TelemetryAdapter } from '../../../shared/types/telemetry';

/**
 * Mutable shared state. Single object, all modules share the same reference.
 * All service types are strongly typed via `import type` (no runtime circular deps).
 */
export interface RuntimeContext {
  // --- Configuration ---
  systemPrompt: string;
  modelConfig: ModelConfig;
  toolRegistry: ToolRegistryLike;
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

  // --- Services / modules ---
  circuitBreaker: CircuitBreaker;
  antiPatternDetector: AntiPatternDetector;
  goalTracker: GoalTracker;
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

  // --- Mutable run state ---
  isCancelled: boolean;
  _isRunning: boolean;
  isInterrupted: boolean;
  interruptMessage: string | null;
  needsReinference: boolean;
  abortController: AbortController | null;

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
  userHooks?: unknown;

  // --- Tool execution ---
  toolCallRetryCount: number;
  maxToolCallRetries: number;
  externalDataCallCount: number;
  preApprovedTools: Set<string>;
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
  currentSystemPromptHash?: string;

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

  // --- Thinking ---
  effortLevel: EffortLevel;
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
  _networkRetried: boolean;
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
}
