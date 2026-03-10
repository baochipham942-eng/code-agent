// ============================================================================
// RuntimeContext — Shared mutable state for all runtime modules
// ============================================================================

import type {
  Message,
  AgentEvent,
} from '../../../shared/types';
import type { StructuredOutputConfig } from '../structuredOutput';
import type { EffortLevel } from '../../../shared/types/agent';

/**
 * Mutable shared state. Single object, all modules share the same reference.
 * Uses `any` for complex service types to avoid circular import issues.
 */
export interface RuntimeContext {
  // --- Configuration ---
  systemPrompt: string;
  modelConfig: any;
  toolRegistry: any;
  toolExecutor: any;
  messages: Message[];
  onEvent: (event: AgentEvent) => void;
  modelRouter: any;
  maxIterations: number;
  workingDirectory: string;
  isDefaultWorkingDirectory: boolean;
  sessionId: string;
  userId?: string;
  persistMessage?: (message: Message) => Promise<void>;
  onToolExecutionLog?: any;

  // --- Services / modules ---
  circuitBreaker: any;
  antiPatternDetector: any;
  goalTracker: any;
  nudgeManager: any;
  hookManager?: any;
  planningService?: any;
  contentVerifier?: any;
  hookMessageBuffer: any;
  messageHistoryCompressor: any;
  autoCompressor: any;
  telemetryAdapter?: any;

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
  userHooks?: any;

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

  // --- Context health ---
  contextHealthy: boolean;
  autoCompressThreshold: number;
  contextBudgetRatio: number;
  genNum: number;
  initialSystemPromptLength: number;
}
