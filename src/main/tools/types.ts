// ============================================================================
// Tool Types - Shared type definitions for all tools
// ============================================================================

import type {
  ToolDefinition,
  JSONSchema,
} from '../../shared/types';

export interface Tool extends ToolDefinition {
  execute: (
    params: Record<string, unknown>,
    context: ToolContext
  ) => Promise<ToolExecutionResult>;
}

export interface ToolContext {
  workingDirectory: string;

  requestPermission: (request: PermissionRequestData) => Promise<boolean>;
  emit?: (event: string, data: unknown) => void;
  emitEvent?: (event: string, data: unknown) => void; // Alias for emit
  planningService?: unknown; // PlanningService instance for persistent planning
  // For subagent execution
  toolRegistry?: ToolRegistryLike;
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
  messages?: import('../../shared/types').Message[];
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
}

export interface PermissionRequestData {
  sessionId?: string;
  forceConfirm?: boolean;
  type: 'file_read' | 'file_write' | 'file_edit' | 'command' | 'network' | 'dangerous_command';
  tool: string;
  details: Record<string, unknown>;
  reason?: string;
  dangerLevel?: 'normal' | 'warning' | 'danger';
}

export interface ToolExecutionResult {
  success: boolean;
  output?: string;
  error?: string;
  result?: unknown; // For caching purposes
  fromCache?: boolean; // Indicates if result was from cache
  metadata?: Record<string, unknown>; // Additional metadata for UI/workflow
}

export interface ToolRegistryLike {
  get(name: string): Tool | undefined;
  getDefaultParamsForAlias(name: string): Record<string, unknown> | undefined;
  register(tool: Tool): void;
  unregister(name: string): boolean;
  getAll(): Tool[];
  getAllTools(): Tool[];
  getToolDefinitions(): ToolDefinition[];
  getCoreToolDefinitions(): ToolDefinition[];
  getDeferredToolDefinitions(): ToolDefinition[];
  getLoadedDeferredToolDefinitions(): ToolDefinition[];
  getDeferredToolsSummary(): string;
  getToolDefinitionWithCloudMeta(name: string): ToolDefinition | undefined;
}
