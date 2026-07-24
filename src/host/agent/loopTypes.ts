// ============================================================================
// Agent Loop Types - Type definitions for AgentLoop internal use
// ============================================================================

import type {
  ModelConfig,
  Message,
  MessageAttachment,
  ToolCall,
  ToolResult,
  AgentEvent,
  ModelDecisionEventData,
  ModelFallbackInfo,
  ModelToolStrategyDiagnostics,
} from '../../shared/contract';
import type {
  ConversationExecutionIntent,
  WorkbenchToolScope,
} from '../../shared/contract/conversationEnvelope';
import type { TelemetryAdapter } from '../../shared/contract/telemetry';
import type { StructuredOutputConfig } from './structuredOutput';
import type { GoalContract } from './goalModeController';
import type { ToolExecutor } from '../tools/toolExecutor';
import type { PlanningService } from '../planning';
import type { HookManager } from '../hooks';
import type { InferenceOptions } from '../model/types';
import type { RunTraceContext } from '../telemetry/runTraceContext';

// ----------------------------------------------------------------------------
// Configuration Types
// ----------------------------------------------------------------------------

/**
 * Agent Loop 配置
 */
export interface AgentLoopConfig {
  systemPrompt?: string;
  modelConfig: ModelConfig;
  toolExecutor: ToolExecutor;
  messages: Message[];
  onEvent: (event: AgentEvent) => void;
  planningService?: PlanningService;
  enableHooks?: boolean;
  hookManager?: HookManager;
  /** Distinct execution identity; never derived from sessionId. */
  runId?: string;
  /** OpenTelemetry authority for this concrete run attempt. */
  runTraceContext?: RunTraceContext;
  sessionId?: string;
  agentId?: string;
  agentName?: string;
  /** 用户显式 /agent 请求的 agent id；与 agentId 不一致 = 显式选择已降级 */
  requestedAgentId?: string;
  userId?: string;
  memoryMode?: import('../../shared/contract/session').SessionMemoryMode;
  suppressedMemoryEntryIds?: string[];
  workingDirectory: string;
  workspaceScope?: import('../../shared/contract/project').WorkspaceScope;
  isDefaultWorkingDirectory?: boolean;
  structuredOutput?: StructuredOutputConfig;
  /** 启用步骤分解执行模式（针对 DeepSeek 等在多步骤任务中容易遗漏步骤的模型） */
  stepByStepMode?: boolean;
  /** 自动批准 plan mode 计划（用于 CLI/测试场景） */
  autoApprovePlan?: boolean;
  /** 启用工具延迟加载（减少 token 使用） */
  enableToolDeferredLoading?: boolean;
  /** 遥测适配器（可选，用于记录原始数据） */
  telemetryAdapter?: TelemetryAdapter;
  /** Per-run provider guardrails for acceptance and controlled runtime harnesses. */
  inferenceOptions?: InferenceOptions;
  /** Per-run iteration cap for acceptance and controlled runtime harnesses. */
  maxIterations?: number;
  /** 当前 run 写入模型历史但不进入用户可见聊天历史。 */
  historyVisibility?: 'visible' | 'meta';
  /** 当前 run 禁用的工具名。 */
  deniedToolNames?: string[];
  /** 工具执行日志回调 */
  onToolExecutionLog?: (log: { sessionId: string; toolCallId: string; toolName: string; args: Record<string, unknown>; result: import('../../shared/contract').ToolResult }) => void;
  /** CLI 模式下的消息持久化回调 */
  persistMessage?: (message: Message) => Promise<void>;
  /** 当前 turn 的显式工具作用域 */
  toolScope?: WorkbenchToolScope;
  /** 当前 turn 的结构化执行意图 */
  executionIntent?: ConversationExecutionIntent;
  /** /goal 自治模式契约；存在则激活 goal 模式（设 ctx.goalMode + maxIterations=maxTurns） */
  goalContract?: GoalContract;
  /** Approved Neo Tag work card context for this run. */
  neoTag?: import('../../shared/contract/tag').NeoTagRunContext;
  /** GAP-013: 启用 Generator-Critic 交付前自动验证（默认读 CODE_AGENT_DELIVERY_CRITIC 环境变量） */
  enableDeliveryCritic?: boolean;
  /** Max Mode（best-of-N，roadmap 3.3）显式开关，默认关（缺省读 CODE_AGENT_MAX_MODE=1 环境变量）。
   *  开 = 每步 N 并发 propose-only 候选 → judge 选索引 → 赢家 replay；N 倍调用成本。 */
  maxMode?: boolean;
  /** Max Mode 并发候选数（默认 MAX_MODE.DEFAULT_CANDIDATES = 5） */
  maxModeCandidates?: number;
}

/**
 * 自主迭代模式配置
 * Agent 根据目标自主循环执行+验证直到满足退出条件或耗尽预算
 */
export interface AutonomousConfig {
  /** 最大外层迭代次数（默认 5） */
  maxOuterIterations?: number;
  /** 最大预算 USD（默认 2.0） */
  maxBudgetUSD?: number;
  /** 最大总时间 ms（默认 600000 = 10 分钟） */
  maxTotalTimeMs?: number;
  /** 验证分数阈值（默认 0.7） */
  scoreThreshold?: number;
  /** 连续无改善轮数阈值（默认 2） */
  maxNoImprovement?: number;
}

/**
 * 从 prompt 解析出的步骤
 */
export interface ParsedStep {
  index: number;
  instruction: string;
  targetFile?: string;
  operation?: 'read' | 'edit' | 'write' | 'other';
}

// ----------------------------------------------------------------------------
// Model Response Types
// ----------------------------------------------------------------------------

/**
 * Model inference response
 */
export interface ModelResponse {
  type: 'text' | 'tool_use' | 'thinking';
  content?: string;
  toolCalls?: ToolCall[];
  truncated?: boolean;
  finishReason?: string;
  actualProvider?: string;
  actualModel?: string;
  fallback?: ModelFallbackInfo;
  // Adaptive Thinking: 思考过程
  thinking?: string;
  // Token usage from API response
  usage?: { inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheCreationTokens?: number; providerReportedSavedTokens?: number };
  // 内容块顺序（text 和 tool_call 的交错顺序）
  contentParts?: Array<{ type: 'text'; text: string } | { type: 'tool_call'; toolCallId: string }>;
  runtimeDiagnostics?: {
    visibleToolNames?: string[];
    toolStrategy?: ModelToolStrategyDiagnostics;
    modelDecision?: ModelDecisionEventData;
    artifactRepairGuard?: {
      targetFile?: string;
      attempts?: number;
      phase?: string;
      patched?: boolean;
      noProgressTurns?: number;
      activeIssueCodes?: string[];
    };
    artifactValidationAttemptCompletion?: {
      targetFile: string;
    };
    /** Max Mode（best-of-N）本步诊断：候选/幸存/赢家索引/是否降级/judge 是否解析成功 */
    maxMode?: {
      candidates: number;
      survivors: number;
      winner: number;
      degraded: boolean;
      judgeParsed: boolean;
      overheadInputTokens: number;
      overheadOutputTokens: number;
    };
  };
}

/**
 * Multimodal message content (matches ModelRouter)
 */
export interface MessageContent {
  type: 'text' | 'image';
  text?: string;
  source?: {
    type: 'base64';
    media_type: string;
    data: string;
  };
}

/**
 * 结构化工具调用（OpenAI wire format）
 */
export interface ModelToolCall {
  id: string;
  name: string;
  arguments: string; // JSON string
}

/**
 * Model message format
 */
export interface ModelMessage {
  role: string;
  content: string | MessageContent[];
  /** assistant 消息的结构化工具调用 */
  toolCalls?: ModelToolCall[];
  /** tool 消息关联的 tool_call_id */
  toolCallId?: string;
  /** tool 消息是否为失败结果（Claude tool_result 需要 is_error） */
  toolError?: boolean;
  /** 文本回退（给不支持 tool calling 的模型用） */
  toolCallText?: string;
  /** 推理/思考内容（Kimi reasoning / DeepSeek reasoning_content） */
  thinking?: string;
  /**
   * 每请求重建的动态尾巴消息（git 状态 / 通知 / persistent context 等）。
   * 位于全部历史之后，内容随请求变化，不属于可缓存前缀；Anthropic 路径
   * 不得在其上打 cache_control 断点。不落库、不进 transcript。
   */
  transient?: boolean;
}

// ----------------------------------------------------------------------------
// Tool Execution Types
// ----------------------------------------------------------------------------

/**
 * Tool execution context passed to ToolExecutor
 */
export interface ToolExecutionContext {
  systemPrompt?: string;
  planningService?: PlanningService;
  modelConfig: ModelConfig;
  setPlanMode: (active: boolean) => void;
  isPlanMode: () => boolean;
  emitEvent: (event: string, data: unknown) => void;
  sessionId: string;
  preApprovedTools: Set<string>;
  currentAttachments: MessageAttachment[];
  executionIntent?: ConversationExecutionIntent;
}

/**
 * Result of tool call classification
 */
export interface ToolClassification {
  parallelGroup: Array<{ index: number; toolCall: ToolCall }>;
  sequentialGroup: Array<{ index: number; toolCall: ToolCall }>;
}

/**
 * Circuit breaker state
 */
export interface CircuitBreakerState {
  consecutiveFailures: number;
  isTripped: boolean;
  lastTripTime?: number;
}

// ----------------------------------------------------------------------------
// Anti-Pattern Detection Types
// ----------------------------------------------------------------------------

/**
 * Tool failure tracking entry
 */
export interface ToolFailureEntry {
  count: number;
  lastError: string;
}

/**
 * Failed tool call pattern match result
 */
export interface FailedToolCallMatch {
  toolName: string;
  args?: string;
}

/**
 * Anti-pattern detection state
 */
export interface AntiPatternState {
  consecutiveReadOps: number;
  hasWrittenFile: boolean;
  toolFailureTracker: Map<string, ToolFailureEntry>;
  duplicateCallTracker: Map<string, number>;
}

// ----------------------------------------------------------------------------
// Progress Tracking Types
// ----------------------------------------------------------------------------

/**
 * Turn-based progress tracking state
 */
export interface TurnProgressState {
  turnId: string;
  startTime: number;
  toolsUsed: string[];
}

// ----------------------------------------------------------------------------
// Constants
// ----------------------------------------------------------------------------

/**
 * Tools that are safe to execute in parallel (stateless, read-only)
 */
export const PARALLEL_SAFE_TOOLS = new Set([
  'read_file',
  'glob',
  'grep',
  'list_directory',
  'web_fetch',
  'web_search',
  'memory_search',
  'mcp_list_tools',
  'mcp_list_resources',
  'mcp_read_resource',
  'mcp_get_status',
  // P5: 子代理任务可并行（只读子代理如 explore, reviewer, plan）
  'Explore',
  'task',
  'Task',  // SDK 版本
]);

/**
 * Tools that modify state and must be executed sequentially
 */
export const SEQUENTIAL_TOOLS = new Set([
  'write_file',
  'edit_file',
  'bash',
  'memory_store',
  'ask_user_question',
  'todo_write' /* 已移除，保留兼容 */,
  // P5: task 已移到并行安全（只读子代理可并行）
  // 注意：spawn_agent 仍需串行，因为可能创建有写权限的代理
  'spawn_agent',
]);

/**
 * Maximum number of tools to execute in parallel
 */
export const MAX_PARALLEL_TOOLS = 4;

/**
 * Read-only tools for anti-pattern tracking
 */
export const READ_ONLY_TOOLS = ['read_file', 'Read', 'glob', 'Glob', 'grep', 'Grep', 'list_directory', 'web_fetch', 'WebFetch', 'web_search', 'WebSearch'];

/**
 * Write tools for anti-pattern tracking
 */
export const WRITE_TOOLS = ['write_file', 'Write', 'append_file', 'Append', 'edit_file', 'Edit'];

/**
 * Verification tools for checkpoint tracking
 */
export const VERIFY_TOOLS = ['bash', 'Bash', 'test', 'compile'];

/**
 * Task progress state for P2 checkpoint validation
 * - exploring: Agent is reading/analyzing files
 * - modifying: Agent is making changes
 * - verifying: Agent is running tests/checks
 * - completed: Task is done
 */
export type TaskProgressState = 'exploring' | 'modifying' | 'verifying' | 'completed';

/**
 * Large binary data fields to filter from tool results
 */
export const LARGE_DATA_FIELDS = [
  'imageBase64',
  'screenshotData',
  'pdfImages',
  'audioData',
  'videoData',
  'base64',
  'data',
];

/**
 * Large data threshold in bytes
 */
export const LARGE_DATA_THRESHOLD = 10000;
