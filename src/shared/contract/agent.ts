// ============================================================================
// Agent Types
// ============================================================================

import type { ModelConfig } from './model';
import type { ToolCall } from './tool';
import type { PermissionRequest } from './permission';
import type { SessionTask, TodoItem } from './planning';
import {
  AgentEventEnvelopeSchema,
  AgentEventSchema,
  EVENT_STABILITY,
  STABLE_EVENT_TYPES,
} from './agentEventSchemas';

export {
  AgentEventEnvelopeSchema,
  AgentEventSchema,
  EVENT_STABILITY,
  STABLE_EVENT_TYPES,
};

// Adaptive Thinking: 思考深度级别
export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra_code';

export interface AgentConfig {
  model: ModelConfig;
  workingDirectory: string;
  // Adaptive Thinking: 思考深度级别
  effort?: EffortLevel;
}

export interface AgentState {
  isRunning: boolean;
  currentToolCalls: ToolCall[];
  pendingPermissions: PermissionRequest[];
  todos: TodoItem[];
}

// Agent 任务阶段（用于长时任务进度追踪）
export type AgentTaskPhase =
  | 'thinking'      // 模型思考中
  | 'tool_pending'  // 等待工具执行
  | 'tool_running'  // 工具执行中
  | 'generating'    // 生成回复中
  | 'completed'     // 完成
  | 'failed';       // 失败

// 任务进度事件数据
export interface TaskProgressData {
  turnId: string;
  phase: AgentTaskPhase;
  step?: string;           // "解析 PDF 内容"
  progress?: number;       // 0-100（可选，工具执行进度）
  tool?: string;           // 当前工具名
  toolIndex?: number;      // 当前工具索引
  toolTotal?: number;      // 工具总数
}

// 任务完成事件数据
export interface TaskCompleteData {
  turnId: string;
  summary?: string;        // "已完成 PDF 分析"
  duration: number;        // 总耗时 ms
  toolsUsed: string[];     // 使用的工具列表
}

// 工具执行进度事件数据（每 5 秒发射一次，用于前端显示耗时）
export interface ToolProgressData {
  toolCallId: string;
  toolName: string;
  elapsedMs: number;       // 已耗时 ms
  detail?: string;         // 可选的描述文本
}

// 工具执行超时警告事件数据（超过阈值时发射）
export interface ToolTimeoutData {
  toolCallId: string;
  toolName: string;
  elapsedMs: number;       // 已耗时 ms
  threshold: number;       // 超时阈值 ms
}

export interface ToolOutputDeltaData {
  toolCallId: string;
  toolName: string;
  stream: 'stdout' | 'stderr';
  content: string;
  elapsedMs?: number;
  truncated?: boolean;
}

export interface MessageDeltaData {
  role: 'assistant';
  path: 'content' | 'reasoning';
  op: 'append' | 'replace';
  text: string;
  turnId?: string;
  messageId?: string;
  deltaSeq?: number;
  parentToolUseId?: string;
}

export interface MessageSnapshotData {
  role: 'assistant';
  turnId?: string;
  messageId?: string;
  content: string;
  reasoning?: string;
  isFinal?: boolean;
  source: 'main_accumulator';
}

export interface TaskUpdateEventData {
  tasks: SessionTask[];
  action: 'create' | 'update' | 'delete' | 'sync';
  taskId?: string;
  taskIds?: string[];
  source?: string;
}

// Web Bridge 本地工具调用请求数据
export interface LocalToolCallData {
  toolCallId: string;
  tool: string;
  originalTool?: string;
  params: Record<string, unknown>;
  permissionLevel: 'L1' | 'L2' | 'L3';
  runId: string;
  sessionId: string;
  workspace: string;
  cwd: string;
}

export interface LocalToolCancelData {
  toolCallId: string;
  runId: string;
  sessionId: string;
}

// Memory 学习完成事件数据
export interface MemoryLearnedData {
  sessionId: string;
  knowledgeExtracted: number;
  codeStylesLearned: number;
  toolPreferencesUpdated: number;
}

// GAP-005: Skill 蒸馏草稿待确认事件数据（半自动确认制，严禁自动入库）
/** skill 草稿来源：telemetry n-gram 机械蒸馏 vs LLM 语义复盘自沉淀 */
export type SkillDraftOrigin = 'telemetry-distilled' | 'llm-review';

export interface SkillDraftPendingData {
  sessionId: string;
  drafts: Array<{
    id: string;
    name: string;
    description: string;
    toolSequence: string[];
    occurrences: number;
    origin: SkillDraftOrigin;
  }>;
}

// role-creation-flow: 对话式建角色草稿待确认（propose_role 工具发射，聊天弹确认卡）
export interface RoleDraftPendingData {
  sessionId: string;
  drafts: Array<{
    id: string;
    roleId: string;
    description: string;
    category?: string;
    tools: string[];
    /** 有值 = 对话式改已有角色（确认卡切「确认修改」文案；缺省 = 新建） */
    editingRoleId?: string;
  }>;
}

/** 对话式建团队配方草稿待确认（propose_team_recipe 工具发射，聊天弹确认卡） */
export interface TeamRecipeDraftPendingData {
  sessionId: string;
  drafts: Array<{
    id: string;
    name: string;
    description: string;
    lead?: { roleId: string; briefTemplate: string };
    members: Array<{ id?: string; roleId: string; taskTemplate: string }>;
    /** 兼容资料转化的前端提示；当前校验失败时草稿不会入队。 */
    unknownRoleNames?: string[];
  }>;
}

// Deep Research 相关类型
export type ResearchPhase = 'planning' | 'researching' | 'reporting' | 'complete' | 'error';

export type ReportStyle =
  | 'default'
  | 'academic'
  | 'popular_science'
  | 'news'
  | 'social_media'
  | 'strategic_investment';

export interface ResearchProgressData {
  phase: ResearchPhase;
  message: string;
  percent: number;
  currentStep?: {
    title: string;
    status: 'running' | 'completed' | 'failed';
  };
  /** 增强的进度信息（语义研究模式） */
  triggeredBy?: 'semantic' | 'manual';
  currentIteration?: number;
  maxIterations?: number;
  coverage?: number;
  activeSources?: string[];
  canDeepen?: boolean;
}

export interface ResearchModeStartedData {
  topic: string;
  reportStyle: ReportStyle;
  /** 触发方式（语义自动触发或手动触发） */
  triggeredBy?: 'semantic' | 'manual';
}

/**
 * 语义检测结果事件数据
 */
export interface ResearchDetectedData {
  intent: string;
  confidence: number;
  suggestedDepth: 'quick' | 'standard' | 'deep';
  reasoning: string;
}

export interface ResearchCompleteData {
  success: boolean;
  report?: {
    title: string;
    content: string;
    sources: Array<{ title: string; url: string }>;
  };
}

export interface ResearchErrorData {
  error: string;
}

// 任务统计事件数据
export interface TaskStatsData {
  elapsed_ms: number;
  iterations: number;
  tokensUsed: number;
  contextUsage: number;
  toolCallCount: number;
  contextWindow: number;
}

export type HookActivitySource = 'global' | 'project';
export type HookActivityType = 'decision' | 'observer';

export interface HookTriggerEventData {
  timestamp: number;
  event: string;
  action: 'allow' | 'block';
  durationMs: number;
  hookCount: number;
  modified: boolean;
  sources: HookActivitySource[];
  hookType: HookActivityType;
  /** 触发的 hook 各自的名字（配置里的 name，没写就退回脚本名）。 */
  names?: string[];
  errorCount?: number;
  message?: string;
  /**
   * block/modify 的决策原因摘要（首行截断、host 侧已脱敏）。渲染层只允许看到这个
   * 单行摘要，完整输出（message）不上屏——见 turnTimeline.ts TurnHookActivityItem。
   */
  reason?: string;
  sessionId?: string;
  turnId?: string;
  toolName?: string;
  matcher?: string;
}

/**
 * 一批 hook 开始执行的信号（hook_trigger 的配对事件）。会话区据此显示 running
 * 指示；对应 hook_trigger 到达即消失。只关心「哪个时机、哪几个 hook」。
 */
export interface HookStartedEventData {
  timestamp: number;
  event: string;
  names?: string[];
  sessionId?: string;
  turnId?: string;
  toolName?: string;
  matcher?: string;
}

export type GoalGateVerificationStatus = 'passed' | 'failed' | 'not_run';
export type GoalGateVerificationFailureType =
  | 'test'
  | 'lint'
  | 'typecheck'
  | 'build'
  | 'env_missing'
  | 'dependency_missing'
  | 'timeout'
  | 'unverifiable';

export interface GoalGateSkippedCheck {
  id: string;
  kind: string;
  reason: string;
  files?: string[];
}

export interface GoalGatePlannedCommand {
  id: string;
  command: string;
  cwd: string;
  required: boolean;
  kind: string;
  reason: string;
  source: string;
  timeoutMs?: number;
}

export interface GoalGateVerificationCommand {
  id: string;
  command: string;
  required: boolean;
  kind: string;
  reason: string;
  pass: boolean;
  exitCode?: number | null;
  durationMs?: number;
  timedOut?: boolean;
  stdoutTail?: string;
  stderrTail?: string;
  outputTail?: string;
  evidenceRefId?: string;
}

/** goal 闸三分支裁决（有界修复 + 到限放行，绝不无限阻塞收尾） */
export type GoalGateVerdict = 'allow_finalize' | 'repair_prompt' | 'exhausted_release';

export interface GoalGateVerificationCard {
  status: GoalGateVerificationStatus;
  failureType?: GoalGateVerificationFailureType;
  summary: string;
  counts: {
    passed: number;
    failed: number;
    notRun: number;
    total: number;
  };
  requiredStatus: 'passed' | 'failed' | 'not_run';
  commands: GoalGateVerificationCommand[];
  evidenceRefIds: string[];
  skippedChecks: GoalGateSkippedCheck[];
}

// routing_resolved 事件载荷：路由真相的权威数据源（IPC 与 web HTTP 两条 run 路径都发射）。
// mode='explicit' 表示本轮 agent 来自用户显式 /agent 选择；requestedAgentId 携带用户
// 请求的 agent id，与 agentId 不一致即为静默兜底被显式化的降级信号。
export interface RoutingResolvedEventData {
  mode: 'auto' | 'explicit';
  agentId: string;
  agentName: string;
  reason: string;
  score: number;
  fallbackToDefault?: boolean;
  requestedAgentId?: string;
  timestamp?: number;
}

/** ADR-040 D2：locator 写前对账的隐私安全遥测，只允许记录分类与原因。 */
export interface ArtifactLocatorTelemetryEventData {
  state: 'resolved' | 'stale' | 'blocked';
  kind: 'spreadsheet' | 'presentation' | 'document';
  reason: string;
}

/** Background task ledger changed; consumers should refresh from the ledger. */
export interface BackgroundTaskLedgerChangedData {
  taskId: string;
  sessionId?: string;
}

/** A file-producing tool resolved its real output path and is about to write. */
export interface ArtifactWriteStartedData {
  toolCallId: string;
  toolName: string;
  filePath: string;
}

export type AgentEvent = import('zod').infer<typeof AgentEventSchema>;
export type AgentEventEnvelope = import('zod').infer<typeof AgentEventEnvelopeSchema>;

// 上下文压缩事件数据
export interface ContextCompressedData {
  savedTokens: number;
  strategy?: string;
  newMessageCount: number;
}

// 中断事件数据
export interface InterruptEventData {
  message: string;
  newUserMessage?: string;
}

// Budget 事件数据
export interface BudgetEventData {
  currentCost: number;
  maxBudget: number;
  usagePercentage: number;
  remaining: number;
  alertLevel: 'silent' | 'warning' | 'blocked';
  message?: string;
}

// Subagent Types (for Gen 3+)
export type SubagentType = 'explore' | 'bash' | 'plan' | 'code-review';

export interface SubagentConfig {
  id: SubagentType;
  name: string;
  description: string;
  availableTools: string[];
  systemPromptOverride?: string;
}
