// ============================================================================
// Agent Types
// ============================================================================

import type { Generation } from './generation';
import type { ModelConfig } from './model';
import type { Message } from './message';
import type { ToolCall, ToolResult } from './tool';
import type { PermissionRequest } from './permission';
import type { TodoItem } from './planning';

export interface AgentConfig {
  generation: Generation;
  model: ModelConfig;
  workingDirectory: string;
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

// Memory 学习完成事件数据
export interface MemoryLearnedData {
  sessionId: string;
  knowledgeExtracted: number;
  codeStylesLearned: number;
  toolPreferencesUpdated: number;
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

export type AgentEvent =
  | { type: 'message'; data: Message }
  | { type: 'tool_call_start'; data: ToolCall & { _index?: number; turnId?: string; parentToolUseId?: string } }
  | { type: 'tool_call_end'; data: ToolResult & { parentToolUseId?: string } }
  | { type: 'permission_request'; data: PermissionRequest }
  | { type: 'error'; data: { message: string; code?: string; suggestion?: string; details?: Record<string, unknown>; parentToolUseId?: string } }
  | { type: 'stream_chunk'; data: { content: string | undefined; turnId?: string; parentToolUseId?: string } }
  | { type: 'stream_reasoning'; data: { content: string | undefined; turnId?: string; parentToolUseId?: string } }
  | { type: 'stream_tool_call_start'; data: { index?: number; id?: string; name?: string; turnId?: string; parentToolUseId?: string } }
  | { type: 'stream_tool_call_delta'; data: { index?: number; name?: string; argumentsDelta?: string; turnId?: string; parentToolUseId?: string } }
  | { type: 'todo_update'; data: TodoItem[] }
  | { type: 'notification'; data: { message: string; parentToolUseId?: string } }
  | { type: 'agent_complete'; data: null }
  // Auto Agent 思考/规划事件
  | { type: 'agent_thinking'; data: { message: string; agentId?: string; progress?: number; parentToolUseId?: string } }
  // Turn-based message events (行业最佳实践: Vercel AI SDK / LangGraph 模式)
  | { type: 'turn_start'; data: { turnId: string; iteration?: number; parentToolUseId?: string } }
  | { type: 'turn_end'; data: { turnId: string; parentToolUseId?: string } }
  // Model capability fallback event (能力补充)
  | { type: 'model_fallback'; data: { reason: string; from: string; to: string } }
  // API Key 缺失提示
  | { type: 'api_key_required'; data: { provider: string; capability: string; message: string } }
  // 长时任务进度追踪（P0 新增）
  | { type: 'task_progress'; data: TaskProgressData & { parentToolUseId?: string } }
  | { type: 'task_complete'; data: TaskCompleteData & { parentToolUseId?: string } }
  // Gen5+ Memory 学习事件
  | { type: 'memory_learned'; data: MemoryLearnedData }
  // Deep Research 事件
  | { type: 'research_mode_started'; data: ResearchModeStartedData }
  | { type: 'research_progress'; data: ResearchProgressData }
  | { type: 'research_complete'; data: ResearchCompleteData }
  | { type: 'research_error'; data: ResearchErrorData }
  // Semantic Research 事件（语义自动触发）
  | { type: 'research_detected'; data: ResearchDetectedData }
  // Budget 预警事件
  | { type: 'budget_warning'; data: BudgetEventData }
  | { type: 'budget_exceeded'; data: BudgetEventData };

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
