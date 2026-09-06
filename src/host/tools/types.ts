// ============================================================================
// Tool Types - Shared type definitions for all tools
// ============================================================================

import type {
  DirectiveMemoryWriteGrant,
  ToolDefinition,
} from '../../shared/contract';
import type { PermissionBoundaryRef } from '../../shared/contract/permissionBoundary';
import type { PermissionRequestReason } from '../../shared/contract/permission';
import type {
  ConversationExecutionIntent,
  WorkbenchToolScope,
} from '../../shared/contract/conversationEnvelope';
import type { SwarmRunScope } from '../../shared/contract/swarm';
import type { WorkspaceScope } from '../../shared/contract/project';
import type { SkillDiscoveryService } from '../services/skills/skillDiscoveryService';
import type { TelemetryCollector } from '../telemetry/telemetryCollector';

export interface Tool extends ToolDefinition {
  execute: (
    params: Record<string, unknown>,
    context: ToolContext
  ) => Promise<ToolExecutionResult>;
}

export interface ToolContext {
  /** Native Run identity only; Agent Team identity lives in swarmRunScope. */
  runId?: string;
  /** Conversation turn that owns this tool call and its durable projections. */
  turnId?: string;
  /** Stable user message that originated this native turn. */
  sourceMessageId?: string;
  /** Immutable authorization/artifact boundary for a run-scoped executor. */
  workspace?: string;
  workspaceScope?: WorkspaceScope;
  workingDirectory: string;

  requestPermission: (request: PermissionRequestData) => Promise<boolean>;
  abortSignal?: AbortSignal;
  /** 当前 run 的工具拒绝集；动态工具发现同样必须遵守。 */
  deniedToolNames?: readonly string[];
  /** 当前 run 的工具白名单（CLI --tools 等）；非空 = 精确白名单，spawn_agent 据此收窄子代理面。 */
  allowedToolNames?: readonly string[];
  /** Run-scoped discovery source; production callers omit it and use the app singleton. */
  skillDiscoveryService?: SkillDiscoveryService;
  /** Run-scoped telemetry owner propagated to spawned agents. */
  telemetryCollector?: TelemetryCollector;
  /**
   * 嵌套工具再入口（PTC / Code Mode）：签发本 context 的那个 ToolExecutor 的完整
   * execute()，审批/guards/收缩档全在。详见 protocol ToolContext.executeTool。
   * 只在最外层工具调用上签发，缺省 = 通道关闭。
   */
  executeTool?: (
    toolName: string,
    params: Record<string, unknown>,
  ) => Promise<ToolExecutionResult>;
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
  /** 当前工具运行采用内部无人值守权限档；协议工具据此启用对应系统边界。 */
  unattended?: boolean;
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
  /**
   * 当前 agent 在 spawn 链路中的嵌套深度（主 agent = 0；每 spawn 一层 +1）。
   * executeSpawnAgent 用它算 childDepth 做 checkDepth 防爆栈，并把 +1 后的值
   * 注入子 toolContext，让深度沿链路流转（swarm 护栏 P1-2 #2）。
   */
  spawnDepth?: number;
  /**
   * 会话级 spawn 深度覆盖。SpawnGuard 会 clamp 到硬上限，未设置时使用默认深度。
   */
  spawnMaxDepth?: number;
  /**
   * 父执行器的「一律走审批 handler」契约。true = 分类器判 approve 也不许自动放行，
   * 必须落到 requestPermission。委派工具要原样透传给子代理执行器：否则子代理里凡是
   * 分类器自动放行的工具（只读联网等）根本不进审批链，父级装的 scripted 策略看不见它。
   * 生产路径缺省 undefined ⇒ 行为零变化。
   */
  forcePermissionHandler?: boolean;
  /** 根 agent / 根 session 的 spawn tree id，整棵树共享同一并发槽位池。 */
  spawnTreeId?: string;
  /** Agent Team 的不可变 run/tree scope；不得覆盖 Native runId，嵌套 spawn 必须原样透传。 */
  swarmRunScope?: SwarmRunScope;
  /** 超额 spawn 等待 tree 槽位的超时时间。 */
  spawnQueueTimeoutMs?: number;
  /** 父 agent 启动时间，用于按父剩余时间收紧子 agent 执行窗口。 */
  spawnParentStartedAt?: number;
  /** 父 agent 执行超时时间，用于计算子 agent 可用剩余窗口。 */
  spawnParentTimeoutMs?: number;
  /** 父 agent 当前剩余预算，作为子 agent 的预算上限。 */
  parentRemainingBudget?: number;
  /** SpawnGuard tree parent id; separate from agentId, which is used by tool isolation. */
  spawnParentAgentId?: string;
  /** goal loop 等受控循环内的后台子 agent 不主动唤醒 idle 父会话。 */
  suppressBackgroundSubagentIdleWake?: boolean;

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
   * subagent 时，用 ctx.resolver 而不是 import 单例，避免硬耦合到 dispatch
   * 单例并方便测试注入 mock。使用点 cast：
   * `(ctx.resolver as import('./dispatch/toolResolver').ToolResolver).execute(...)`
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
  /** Approved Neo Tag work card runtime context. */
  neoTag?: import('../../shared/contract/tag').NeoTagRunContext;
  /** 绑定本次参数与目标的记忆目录写授权，不得跨工具调用复用。 */
  directiveMemoryWriteGrant?: DirectiveMemoryWriteGrant;
}

export interface PermissionRequestData {
  sessionId?: string;
  /** 请求来自无人值守 run；审批层不得借同 session 的 renderer 进入无限等待。 */
  unattended?: boolean;
  agentId?: string;
  runId?: string;
  parentToolUseId?: string;
  forceConfirm?: boolean;
  type: 'file_read' | 'file_write' | 'file_edit' | 'command' | 'network' | 'dangerous_command' | 'directory_access';
  tool: string;
  details: Record<string, unknown>;
  reason?: string;
  /** 结构化原因码（与 reason 文案并行，可追溯/可测试/可 i18n） */
  reasonCode?: PermissionRequestReason;
  boundary?: PermissionBoundaryRef;
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
