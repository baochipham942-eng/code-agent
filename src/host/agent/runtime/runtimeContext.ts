// ============================================================================
// RuntimeContext — Shared mutable state for all runtime modules
// ============================================================================

import type {
  Message,
  AgentEvent,
  ToolResult,
} from '../../../shared/contract';
import type { ModelConfig } from '../../../shared/contract/model';
import type { ModelDecision } from '../../../shared/contract/modelDecision';
import type { ToolExecutor } from '../../tools/toolExecutor';
import type { ModelRouter } from '../../model/modelRouter';
import type { CircuitBreaker } from '../toolExecution/circuitBreaker';
import type { AntiPatternDetector } from '../antiPattern/detector';
import type { GoalTracker } from '../goalTracker';
import type { GoalModeController } from '../goalModeController';
import type { ScaffoldProfile } from './scaffoldProfile';
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
import type { TurnTraceRecorder } from './turnTrace';
import type { TurnState } from './turnState';
import type { SessionMemoryMode } from '../../../shared/contract/session';
import type { RunTraceContext } from '../../telemetry/runTraceContext';
import type { GoalEvidenceGateState } from './goalEvidenceGate';
import type { TurnQualityRunState } from './turnQuality';

/**
 * Mutable shared state. Single object, all modules share the same reference.
 * All service types are strongly typed via `import type` (no runtime circular deps).
 */
export interface RuntimeContext {
  // --- Configuration ---
  readonly systemPrompt: string;
  modelConfig: ModelConfig;
  readonly toolExecutor: ToolExecutor;
  messages: Message[];
  readonly onEvent: (event: AgentEvent) => void;
  readonly modelRouter: ModelRouter;
  readonly maxIterations: number;
  readonly workingDirectory: string;
  readonly isDefaultWorkingDirectory: boolean;
  readonly runId?: string;
  readonly runTraceContext?: RunTraceContext;
  readonly sessionId: string;
  readonly agentId?: string;
  readonly agentName?: string;
  /** 用户显式 /agent 请求的 agent id；与 agentId 不一致 = 显式选择已降级 */
  readonly requestedAgentId?: string;
  readonly userId?: string;
  readonly memoryMode?: SessionMemoryMode;
  readonly suppressedMemoryEntryIds?: string[];
  readonly persistMessage?: (message: Message) => Promise<void>;
  readonly onToolExecutionLog?: (log: { sessionId: string; toolCallId: string; toolName: string; args: Record<string, unknown>; result: ToolResult }) => void;
  readonly toolScope?: WorkbenchToolScope;
  readonly executionIntent?: ConversationExecutionIntent;
  readonly neoTag?: import('../../../shared/contract/tag').NeoTagRunContext;

  // --- Services / modules ---
  readonly circuitBreaker: CircuitBreaker;
  readonly antiPatternDetector: AntiPatternDetector;
  readonly goalTracker: GoalTracker;
  /** /goal 自治循环控制器；仅 goal 模式下存在（opt-in），普通 run 为 undefined */
  readonly goalMode?: GoalModeController;
  readonly nudgeManager: NudgeManager;
  hookManager?: HookManager;
  readonly planningService?: PlanningService;
  readonly hookMessageBuffer: HookMessageBuffer;
  readonly messageHistoryCompressor: MessageHistoryCompressor;
  readonly autoCompressor: AutoContextCompressor;
  compressionState: CompressionState;
  readonly compressionPipeline: CompressionPipeline;
  readonly telemetryAdapter?: TelemetryAdapter;
  readonly inferenceOptions?: InferenceOptions;
  readonly historyVisibility?: 'visible' | 'meta';
  readonly deniedToolNames?: string[];

  // --- Turn 级状态切片（ADR-038 批3a，写操作走 TurnState 方法）---
  readonly turn: TurnState;

  // --- Mutable run state ---
  isCancelled: boolean;
  isInterrupted: boolean;
  abortController: AbortController | null;
  runAbortController: AbortController | null;

  // --- Plan mode ---
  savedMessages: Message[] | null;
  readonly autoApprovePlan: boolean;

  // --- Hooks ---
  readonly enableHooks: boolean;
  readonly maxStopHookRetries: number;
  /** GAP-013: Generator-Critic 交付前自动验证开关 */
  readonly enableDeliveryCritic: boolean;

  // --- Tool execution ---
  readonly maxToolCallRetries: number;
  externalDataCallCount: number;
  preApprovedTools: Set<string>;
  readonly enableToolDeferredLoading: boolean;

  // --- Max Mode（best-of-N，roadmap 3.3）---
  /** 显式开关（默认关）：开 = 每步 N 并发 propose-only 候选 → judge 选索引 → 赢家 replay */
  readonly maxMode: boolean;
  /** 并发候选数（默认 MAX_MODE.DEFAULT_CANDIDATES） */
  readonly maxModeCandidates: number;

  // --- Structured output ---
  readonly maxStructuredOutputRetries: number;

  // --- Step-by-step ---
  readonly stepByStepMode: boolean;

  // --- Tracing ---
  traceId: string;
  lastModelTraceSpanId?: string;
  currentSystemPromptHash?: string;
  /** G20: per-run 结构化 turn trace（决策 / dispatch / compaction） */
  readonly turnTrace: TurnTraceRecorder;
  /** 2d: turn quality run 级记忆（owner=turnQuality） */
  readonly turnQualityState: TurnQualityRunState;
  turnModelDecision?: ModelDecision;
  pendingRuntimeDiagnostics: string[];
  /** GAP-023: 当前生效 system prompt 构建时被预算丢弃/裁剪的块（可见化到 context health） */
  droppedPromptBlocks?: string[];
  forceFinalResponseReason?: string;
  forceFinalResponsePrompt?: string;
  /** Last interactive artifact path that passed runtime/browser validation in this run. */
  artifactValidationPassedTargetFile?: string;
  /**
   * Final artifact contract（maka 借鉴）：模型开工前声明的最终产物与草稿区。
   * 声明后产物校验/修复锁定/goal 证据闸/工作区卫生检查都以此为锚。
   */
  declaredDeliverables?: {
    /** 最终交付产物路径（相对 workingDirectory 或绝对路径） */
    finalArtifacts: string[];
    /** 草稿/中间产物目录（卫生检查豁免区） */
    scratchDir?: string;
    declaredAtMs: number;
  };
  /** 2d: goal 证据闸打回计数（owner=goalEvidenceGate） */
  readonly goalEvidenceState: GoalEvidenceGateState;
  artifactRepairGuard?: {
    targetFile: string;
    attempts: number;
    phase: string;
    // Route A loop guard: repair turns since the last successful target-file
    // mutation. Reaching ARTIFACT_REPAIR_MAX_ATTEMPTS force-stops the repair turn.
    repairTurnsWithoutProgress?: number;
    // Route A block-path loop guard：可用但被 repair 闸 block 的工具连续无进展次数。
    // 独立于 repairTurnsWithoutProgress（后者每回合被 messageProcessor 无条件清零，
    // 无法兜住"目标不可达→每个工具都被 block"的死锁）。仅 block 路径累加、目标文件被
    // 成功改动(patched)时清零，到 ARTIFACT_REPAIR_MAX_ATTEMPTS 硬停。
    blockedToolTurnsWithoutProgress?: number;
    lastBlockedTool?: string;
    patched?: boolean;
    lastFailedPatchFingerprint?: string;
    activeIssueCodes?: string[];
  };

  // --- Budget ---
  totalInputTokens: number;
  totalOutputTokens: number;
  readonly consecutiveErrors: number;

  // --- Thinking ---
  /** B7：模型能力档 → 脚手架注入厚度（单一真源，消费方只读字段不自查 tier；缺省视同 standard） */
  readonly scaffoldProfile?: ScaffoldProfile;

  // --- Task stats ---
  runStartTime: number;
  totalTokensUsed: number;
  totalToolCallCount: number;

  // --- Context recovery ---
  _networkRetryCount?: number;
  readonly MAX_CONSECUTIVE_TRUNCATIONS: number;
  readonly MAX_CONSECUTIVE_COMPACTS: number;

  // --- Persistent system context ---
  // 任务指导类信息（复杂度提示、并行建议、任务模式 reminder 等）
  // 存在此处而非 ctx.messages，确保每轮推理都作为 system prompt 的一部分可见
  persistentSystemContext: string[];

  // --- Context health ---
  /** G12/P2-full: 本 turn CompressionPipeline 是否报了 autocompact-needed。
   *  由 messageBuild 写入，checkAndAutoCompress 经 ContextPressureController 消费后清零。 */
  pipelineAutocompactNeeded: boolean;
  /** Roadmap 3.4: last message watermark that already received a checkpoint rebuild boundary. */
  checkpointRebuildLastWatermarkId?: string;
  /** Test/host override for checkpoint artifact storage. Defaults to app user data. */
  readonly checkpointRootDir?: string;
}
