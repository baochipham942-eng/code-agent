// ============================================================================
// Agent Types
// ============================================================================

import type { ModelConfig } from './model';
import type { Message } from './message';
import type { ToolCall, ToolResult } from './tool';
import type { PermissionRequest } from './permission';
import type { SessionTask, TodoItem } from './planning';
import type { FileDiff } from './diff';
import type { EvidenceRef } from './evidence';
import type { ModelDecisionEventData, ModelFallbackInfo, ModelFallbackStrategy, ModelFallbackToolPolicy, ModelFallbackTraceStep, ModelProviderIdentity, ModelToolStrategyDiagnostics } from './modelDecision';

// Adaptive Thinking: 思考深度级别
export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra_code';

// Interaction Mode: Code / Plan / Ask
export type InteractionMode = 'code' | 'plan' | 'ask';

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
  params: Record<string, unknown>;
  permissionLevel: 'L1' | 'L2' | 'L3';
  sessionId?: string;
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
  errorCount?: number;
  message?: string;
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

export type AgentEvent =
  | { type: 'message'; data: Message }
  | { type: 'tool_call_start'; data: ToolCall & { _index?: number; turnId?: string; parentToolUseId?: string } }
  | { type: 'tool_call_end'; data: ToolResult & { parentToolUseId?: string } }
  | { type: 'permission_request'; data: PermissionRequest }
  | { type: 'model_decision'; data: ModelDecisionEventData }
  | { type: 'hook_trigger'; data: HookTriggerEventData }
  | { type: 'error'; data: { message: string; code?: string; suggestion?: string; details?: Record<string, unknown>; parentToolUseId?: string } }
  | { type: 'message_delta'; data: MessageDeltaData }
  | { type: 'message_snapshot'; data: MessageSnapshotData }
  | { type: 'stream_chunk'; data: { content: string | undefined; turnId?: string; parentToolUseId?: string } }
  | { type: 'stream_reasoning'; data: { content: string | undefined; turnId?: string; parentToolUseId?: string } }
  | { type: 'stream_tool_call_start'; data: { index?: number; id?: string; name?: string; turnId?: string; parentToolUseId?: string } }
  | { type: 'stream_tool_call_delta'; data: { index?: number; name?: string; argumentsDelta?: string; turnId?: string; parentToolUseId?: string } }
  | { type: 'todo_update'; data: TodoItem[] }
  | { type: 'task_update'; data: TaskUpdateEventData }
  | { type: 'notification'; data: { message: string; parentToolUseId?: string } }
  | { type: 'routing_resolved'; data: {
      mode: 'auto';
      agentId: string;
      agentName: string;
      reason: string;
      score: number;
      fallbackToDefault?: boolean;
      timestamp?: number;
    } }
  | { type: 'agent_complete'; data: null }
  | { type: 'agent_cancelled'; data: null }
  // /goal 自治模式观测事件
  | { type: 'goal_iteration'; data: { turn: number; maxTurns: number; goalStatus: string; tokensUsed: number; tokenBudget: number; wallClockBudgetMs?: number; parentToolUseId?: string } }
  | { type: 'goal_gate'; data: { gate: number; pass: boolean; exitCode?: number | null; timedOut?: boolean; reason?: string; parentToolUseId?: string; verdict?: GoalGateVerdict; attempt?: number; verificationStatus?: GoalGateVerificationStatus; failureType?: GoalGateVerificationFailureType; evidenceRefs?: EvidenceRef[]; skippedChecks?: GoalGateSkippedCheck[]; plannedOptionalCommands?: GoalGatePlannedCommand[]; verificationCard?: GoalGateVerificationCard } }
  // /goal 终态：三闸全过(met) 或 闸3 兜底中止(aborted)。前端据此展示"已完成/已中止"+停表。
  // degraded：到限放行（修复预算耗尽仍未过验证）——met 但带安静降级标识。
  | { type: 'goal_complete'; data: { status: 'met' | 'aborted'; reason?: string; turns: number; tokensUsed: number; degraded?: boolean; degradedReason?: string; parentToolUseId?: string } }
  // Auto Agent 思考/规划事件
  | { type: 'agent_thinking'; data: { message: string; agentId?: string; progress?: number; parentToolUseId?: string } }
  // Turn-based message events (行业最佳实践: Vercel AI SDK / LangGraph 模式)
  | { type: 'turn_start'; data: { turnId: string; iteration?: number; parentToolUseId?: string } }
  | { type: 'turn_end'; data: { turnId: string; parentToolUseId?: string } }
  | { type: 'tool_schema_snapshot'; data: {
      turnId?: string;
      toolCount: number;
      tools: Array<{
        name: string;
        inputSchema?: Record<string, unknown>;
        requiresPermission?: boolean;
        permissionLevel?: string;
      }>;
      parentToolUseId?: string;
    } }
  | { type: 'model_response'; data: {
      model: string;
      provider?: string;
      responseType: string;
      duration: number;
      toolCalls: string[];
      textLength: number;
      inputTokens?: number;
      outputTokens?: number;
      requestedModel?: string;
      requestedProvider?: string;
      fallback?: ModelFallbackInfo;
      runtimeDiagnostics?: {
        visibleToolNames?: string[];
        toolStrategy?: ModelToolStrategyDiagnostics;
        modelDecision?: ModelDecisionEventData;
        artifactRepairGuard?: {
          targetFile?: string;
          attempts?: number;
          phase?: string;
          patched?: boolean;
          repairTurnsWithoutProgress?: number;
          activeIssueCodes?: string[];
        };
        /** Max Mode（best-of-N）本步诊断（Codex R1-LOW：补齐事件契约类型） */
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
    } }
  // Model capability fallback event (能力补充)
  | { type: 'model_fallback'; data: { reason: string; from: string; to: string; category?: string; strategy?: ModelFallbackStrategy; tried?: ModelFallbackTraceStep[]; skipped?: ModelFallbackTraceStep[]; toolPolicy?: ModelFallbackToolPolicy; fromIdentity?: ModelProviderIdentity; toIdentity?: ModelProviderIdentity; turnId?: string } }
  // API Key 缺失提示
  | { type: 'api_key_required'; data: { provider: string; capability: string; message: string } }
  // 长时任务进度追踪（P0 新增）
  | { type: 'task_progress'; data: TaskProgressData & { parentToolUseId?: string } }
  | { type: 'task_complete'; data: TaskCompleteData & { parentToolUseId?: string } }
  // Memory 学习事件
  | { type: 'memory_learned'; data: MemoryLearnedData }
  // GAP-005: Skill 蒸馏草稿待确认事件（session 结束学习产出，弹用户确认）
  | { type: 'skill_draft_pending'; data: SkillDraftPendingData }
  // role-creation-flow: 对话式建角色草稿待确认事件
  | { type: 'role_draft_pending'; data: RoleDraftPendingData }
  // Deep Research 事件
  | { type: 'research_mode_started'; data: ResearchModeStartedData }
  | { type: 'research_progress'; data: ResearchProgressData }
  | { type: 'research_complete'; data: ResearchCompleteData }
  | { type: 'research_error'; data: ResearchErrorData }
  // Semantic Research 事件（语义自动触发）
  | { type: 'research_detected'; data: ResearchDetectedData }
  // Budget 预警事件
  | { type: 'budget_warning'; data: BudgetEventData }
  | { type: 'budget_exceeded'; data: BudgetEventData }
  // 上下文压缩事件
  | { type: 'context_compressed'; data: ContextCompressedData }
  // 中断事件（Claude Code 风格）
  | { type: 'interrupt_start'; data: InterruptEventData }
  | { type: 'interrupt_acknowledged'; data: InterruptEventData }
  | { type: 'interrupt_complete'; data: InterruptEventData }
  // E3: 变更追踪
  | { type: 'diff_computed'; data: FileDiff }
  // E1: 引用溯源
  | { type: 'citations_updated'; data: { citations: import('./citation').Citation[] } }
  // E4: 模型切换
  | { type: 'model_switched'; data: { from: string; to: string; provider?: string } }
  // 工具执行进度（每 5 秒发射，前端展示耗时）
  | { type: 'tool_progress'; data: ToolProgressData }
  // 工具输出增量（前台 Bash 等长命令边跑边显示 stdout/stderr）
  | { type: 'tool_output_delta'; data: ToolOutputDeltaData }
  // 工具执行超时警告（超过阈值时发射）
  | { type: 'tool_timeout'; data: ToolTimeoutData }
  // Plan mode events
  | { type: 'plan_mode_entered'; data: { reason: string } }
  | { type: 'plan_mode_exited'; data: { plan: string } }
  // Task stats event
  | { type: 'task_stats'; data: TaskStatsData }
  // Context compaction events (Claude Code style)
  | { type: 'context_compacting'; data: { tokensBefore: number; messagesCount: number } }
  | { type: 'context_compacted'; data: { tokensBefore: number; tokensAfter: number; messagesRemoved: number; duration_ms: number } }
  // 实时 token 用量（SSE usage / token_estimate 事件）
  | { type: 'stream_usage'; data: { inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheCreationTokens?: number; turnId?: string } }
  | { type: 'stream_token_estimate'; data: { inputTokens: number; outputTokens: number; turnId?: string } }
  // Web Bridge: 本地工具调用请求（webServer → 前端 → Bridge）
  | { type: 'tool_call_local'; data: LocalToolCallData }
  // Context-aware follow-up suggestions
  | { type: 'suggestions_update'; data: Array<{ id: string; text: string; source: string }> };

export type AgentEventEnvelope = AgentEvent & {
  sessionId?: string;
  seq?: number;
};

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
