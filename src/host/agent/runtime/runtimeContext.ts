// ============================================================================
// RuntimeContext — 运行时组合根（ADR-038 拆袋后）
// ============================================================================

import type {
  Message,
  AgentEvent,
  ToolResult,
} from '../../../shared/contract';
import type { ModelConfig } from '../../../shared/contract/model';
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
import type { CompressionPipeline } from '../../context/compressionPipeline';
import type { TelemetryAdapter } from '../../../shared/contract/telemetry';
import type { InferenceOptions } from '../../model/types';
import type {
  ConversationExecutionIntent,
  WorkbenchToolScope,
} from '../../../shared/contract/conversationEnvelope';
import type { TurnTraceRecorder } from './turnTrace';
import type { TurnState } from './turnState';
import type { ControlState } from './controlState';
import type { ContextHealthState } from './contextHealthState';
import type { RunStatsState } from './runStatsState';
import type { ArtifactState } from './artifactState';
import type { SessionMemoryMode } from '../../../shared/contract/session';
import type { RunTraceContext } from '../../telemetry/runTraceContext';
import type { GoalEvidenceGateState } from './goalEvidenceGate';
import type { TurnQualityRunState } from './turnQuality';

/**
 * 运行时组合根：单对象，所有 runtime 模块共享同一引用（ADR-038）。
 * 可变状态已按域收敛为方法驱动的切片，写操作走切片方法、不再平铺散字段：
 * - turn: TurnState（批3a）— turn/iteration 生命周期、推理流转、thinking/effort、激活 skill
 * - control: ControlState（批3b）— 取消/中断/abort/plan 快照/强制收尾
 * - contextHealth: ContextHealthState（批3c）— 压缩态/持久上下文/丢块/水位线
 * - stats: RunStatsState（批3d）— token/工具计数与 tracing
 * - artifact: ArtifactState（批3e）— repair guard/验收通过标记/declared deliverables
 * 其余为 readonly 配置与服务句柄；service 类型一律 `import type`（无运行时环依赖）。
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
  readonly compressionPipeline: CompressionPipeline;
  readonly telemetryAdapter?: TelemetryAdapter;
  readonly inferenceOptions?: InferenceOptions;
  readonly historyVisibility?: 'visible' | 'meta';
  readonly deniedToolNames?: string[];

  // --- Turn 级状态切片（ADR-038 批3a，写操作走 TurnState 方法）---
  readonly turn: TurnState;

  // --- 控制流状态切片（ADR-038 批3b，写操作走 ControlState 方法）---
  readonly control: ControlState;

  // --- Plan mode ---
  readonly autoApprovePlan: boolean;

  // --- Hooks ---
  readonly enableHooks: boolean;
  readonly maxStopHookRetries: number;
  /** GAP-013: Generator-Critic 交付前自动验证开关 */
  readonly enableDeliveryCritic: boolean;

  // --- Tool execution ---
  readonly maxToolCallRetries: number;
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

  // --- RunStats+Tracing（ADR-038 批3d，写操作走 RunStatsState 方法）---
  readonly stats: RunStatsState;

  /** G20: per-run 结构化 turn trace（决策 / dispatch / compaction） */
  readonly turnTrace: TurnTraceRecorder;
  /** 2d: turn quality run 级记忆（owner=turnQuality） */
  readonly turnQualityState: TurnQualityRunState;
  // --- Artifact 状态切片（ADR-038 批3e，写操作走 ArtifactState 方法）---
  readonly artifact: ArtifactState;
  /** 2d: goal 证据闸打回计数（owner=goalEvidenceGate） */
  readonly goalEvidenceState: GoalEvidenceGateState;

  // --- Budget ---
  readonly consecutiveErrors: number;

  // --- Thinking ---
  /** B7：模型能力档 → 脚手架注入厚度（单一真源，消费方只读字段不自查 tier；缺省视同 standard） */
  readonly scaffoldProfile?: ScaffoldProfile;

  // --- Task stats ---

  // --- Context recovery ---
  readonly MAX_CONSECUTIVE_TRUNCATIONS: number;
  readonly MAX_CONSECUTIVE_COMPACTS: number;


  // --- Context health（ADR-038 批3c，写操作走 ContextHealthState 方法）---
  readonly contextHealth: ContextHealthState;
  /** Test/host override for checkpoint artifact storage. Defaults to app user data. */
  readonly checkpointRootDir?: string;
}
