// ============================================================================
// Tool Types - Shared type definitions for all tools
// ============================================================================

import type {
  ToolDefinition,
} from '../../shared/contract';
import type {
  ConversationExecutionIntent,
  WorkbenchToolScope,
} from '../../shared/contract/conversationEnvelope';

export interface Tool extends ToolDefinition {
  execute: (
    params: Record<string, unknown>,
    context: ToolContext
  ) => Promise<ToolExecutionResult>;
}

export interface ToolContext {
  workingDirectory: string;

  requestPermission: (request: PermissionRequestData) => Promise<boolean>;
  abortSignal?: AbortSignal;
  emit?: (event: string, data: unknown) => void;
  emitEvent?: (event: string, data: unknown) => void; // Alias for emit
  planningService?: unknown; // PlanningService instance for persistent planning
  // For subagent execution
  modelConfig?: unknown;
  // Plan Mode support (borrowed from Claude Code v2.0)
  setPlanMode?: (active: boolean) => void;
  isPlanMode?: () => boolean;
  // Current message attachments (images, files) for multi-agent workflows
  currentAttachments?: Array<{
    type: string;
    category?: string;
    name?: string;
    path?: string;
    data?: string;
    mimeType?: string;
  }>;
  // 当前工具调用 ID（用于 subagent 追踪）
  currentToolCallId?: string;

  // ============================================================================
  // Phase 0: Subagent 上下文传递支持
  // ============================================================================

  /** 会话 ID（用于上下文追踪） */
  sessionId?: string;
  /** 对话历史（用于 Subagent 上下文注入） */
  messages?: import('../../shared/contract').Message[];
  /** 已修改的文件集合（用于 Subagent 上下文注入） */
  modifiedFiles?: Set<string>;
  /** TODO 列表（用于 Subagent 上下文注入） */
  todos?: Array<{ id: string; content: string; status: 'pending' | 'in_progress' | 'completed' | 'cancelled' }>;
  /** 上下文级别覆盖（可选） */
  contextLevel?: 'minimal' | 'relevant' | 'full';

  // ============================================================================
  // Teammate 通信支持
  // ============================================================================

  /** 当前 Agent ID（用于 teammate 工具识别身份） */
  agentId?: string;
  /** 当前 Agent 名称 */
  agentName?: string;
  /** 当前 Agent 角色 */
  agentRole?: string;

  // ============================================================================
  // 模型回调支持（工具内二次调用模型）
  // ============================================================================

  /** 模型推理回调：接收 prompt 文本，返回模型响应文本 */
  modelCallback?: (prompt: string) => Promise<string>;

  // ============================================================================
  // Hook 系统支持
  // ============================================================================

  /** HookManager 引用（用于 subagent/permission 事件触发） */
  hookManager?: import('../hooks/hookManager').HookManager;

  // ============================================================================
  // 跨工具调度 / subagent spawn
  // ============================================================================

  /**
   * ToolResolver 引用。工具内需要调度兄弟工具（DocEdit → ppt_edit）或 spawn
   * subagent 时，用 ctx.resolver 而不是 import 单例，避免 tools/* 反向静态引用
   * protocol/dispatch/* 形成静态闭环。使用点 cast：
   * `(ctx.resolver as import('../protocol/dispatch/toolResolver').ToolResolver).execute(...)`
   */
  resolver?: unknown;
  /**
   * ToolExecutor 已经完成顶层权限决策的原始调用。
   * protocol handler 的首个同参 canUseTool 可复用该结果，子操作仍需重新请求。
   */
  approvedToolCall?: {
    toolName: string;
    args: Record<string, unknown>;
  };
  /** 当前 turn 的显式工具作用域 */
  toolScope?: WorkbenchToolScope;
  /** 当前 turn 的结构化执行意图 */
  executionIntent?: ConversationExecutionIntent;
}

export interface PermissionRequestData {
  sessionId?: string;
  forceConfirm?: boolean;
  type: 'file_read' | 'file_write' | 'file_edit' | 'command' | 'network' | 'dangerous_command';
  tool: string;
  details: Record<string, unknown>;
  reason?: string;
  dangerLevel?: 'normal' | 'warning' | 'danger';
  /** Decision trace: why this permission was requested (populated on deny/ask) */
  decisionTrace?: import('../../shared/contract/decisionTrace').DecisionTrace;
}

export interface ToolExecutionResult {
  success: boolean;
  output?: string;
  error?: string;
  outputPath?: string; // Explicit path for file-producing tools (consumed by frontend artifact detection)
  result?: unknown; // For caching purposes
  fromCache?: boolean; // Indicates if result was from cache
  metadata?: Record<string, unknown>; // Additional metadata for UI/workflow
}
