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
import type { ModelDecision, ModelDecisionEventData } from '../../../shared/contract/modelDecision';
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
import type { SkillInvocationMatchKind } from '../../services/skills/skillInvocationResolver';
import type { SkillToolBoundary } from '../../../shared/contract/agentSkill';
import type { TurnTraceRecorder } from './turnTrace';
import type { SessionMemoryMode } from '../../../shared/contract/session';
import type { TurnQualityMemorySummary } from '../../../shared/contract/turnQuality';
import type { RunTraceContext } from '../../telemetry/runTraceContext';

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
  runId?: string;
  runTraceContext?: RunTraceContext;
  sessionId: string;
  agentId?: string;
  agentName?: string;
  /** 用户显式 /agent 请求的 agent id；与 agentId 不一致 = 显式选择已降级 */
  requestedAgentId?: string;
  userId?: string;
  memoryMode?: SessionMemoryMode;
  suppressedMemoryEntryIds?: string[];
  persistMessage?: (message: Message) => Promise<void>;
  onToolExecutionLog?: (log: { sessionId: string; toolCallId: string; toolName: string; args: Record<string, unknown>; result: ToolResult }) => void;
  toolScope?: WorkbenchToolScope;
  executionIntent?: ConversationExecutionIntent;
  neoTag?: import('../../../shared/contract/tag').NeoTagRunContext;

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
  currentModelDecision?: ModelDecisionEventData;
  historyVisibility?: 'visible' | 'meta';
  deniedToolNames?: string[];

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
  /** GAP-013: 本 run 已被交付前 critic 拦下打回的次数；达 DELIVERY_CRITIC.MAX_BLOCKS 后强制放行
   * （防无限循环）。原 deliveryCriticRan(boolean) 升级而来。 */
  deliveryCriticBlockCount: number;
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

  // --- Max Mode（best-of-N，roadmap 3.3）---
  /** 显式开关（默认关）：开 = 每步 N 并发 propose-only 候选 → judge 选索引 → 赢家 replay */
  maxMode: boolean;
  /** 并发候选数（默认 MAX_MODE.DEFAULT_CANDIDATES） */
  maxModeCandidates: number;

  // --- Structured output ---
  structuredOutput?: StructuredOutputConfig;
  structuredOutputRetryCount: number;
  maxStructuredOutputRetries: number;

  // --- Step-by-step ---
  stepByStepMode: boolean;

  // --- Tracing ---
  traceId: string;
  currentIterationSpanId: string;
  lastModelTraceSpanId?: string;
  currentTurnId: string;
  messageDeltaSeq: number;
  currentSystemPromptHash?: string;
  /** WP2-2b：完整请求前缀 shape hash（system+消息结构），仅 telemetry 诊断 */
  currentRequestShapeHash?: string;
  /** G20: per-run 结构化 turn trace（决策 / dispatch / compaction） */
  turnTrace: TurnTraceRecorder;
  turnQualityMemory?: TurnQualityMemorySummary;
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
  /** goal 证据闸（闸0）：本次 goal 内因证据不足被打回的次数（防无限打回） */
  goalEvidenceGateBounces?: number;
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

  // 最近 N 次工具调用的工具名（与 recentToolFingerprints 平行）。
  // 用于检测"语义重复搜索"：同一检索类工具高频出现（换词重搜同一意图）。
  recentToolNames: string[];
  searchSpamWarningEmitted: boolean;

  // --- Ground-truth gate ---
  // 本次 run 中 tool result 命中反爬指纹的次数。finalize 时如果用户消息含 URL
  // 且此计数 >= 阈值，给最终 assistant_response 加一个 disclaimer，避免幻觉伪造
  // 内容被当成"成功获取"上交。
  antiScrapingHitsInRun: number;

  // --- Thinking ---
  effortLevel: EffortLevel;
  thinkingEnabled: boolean;
  thinkingStepCount: number;
  /** B7：模型能力档 → 脚手架注入厚度（单一真源，消费方只读字段不自查 tier；缺省视同 standard） */
  scaffoldProfile?: ScaffoldProfile;

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
  /** Item2 卡死护栏：连续付费摘要后仍未降到阈值下的次数。降下去清零。 */
  _consecutiveCompacts: number;
  MAX_CONSECUTIVE_COMPACTS: number;
  /** ≥MAX_CONSECUTIVE_COMPACTS 后置位：窗口太小，暂停自动压缩、停止烧 token 摘要。 */
  _autoCompactPaused: boolean;
  /** WP2-3：连续摘要失败次数（校验不过/调用异常），成功清零。 */
  _summaryFailureStreak: number;
  /** WP2-3：摘要失败冷却截止时间戳；冷却期内跳过付费 AI 摘要。 */
  _summaryCooldownUntil: number;

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
  /** Roadmap 3.4: last message watermark that already received a checkpoint rebuild boundary. */
  checkpointRebuildLastWatermarkId?: string;
  /** Test/host override for checkpoint artifact storage. Defaults to app user data. */
  checkpointRootDir?: string;
}
