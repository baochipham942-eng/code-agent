import type { ModelConfig, PermissionPreset } from '../../shared/contract';
import type { SwarmAgentContextSnapshot } from '../../shared/contract/swarm';
import type { CancellationReason } from '../../shared/contract/cancellation';
import type { ToolContext } from '../tools/types';
import type { ToolResolver } from '../tools/dispatch/toolResolver';
import type { HookManager } from '../hooks/hookManager';
import type { AgentMessage } from './spawnGuard';
import type { ParentContext } from './childContext';

export interface SubagentConfig {
  name: string;
  /**
   * 角色 ID（agent 注册 id，即 agents/<id>.md 的 frontmatter name）。
   * 持久化角色资产（roles/<roleId>/）按这个 id 绑定——config.name 是显示名
   * （自定义 agent 的 name = description），不能用作绑定 key。
   * 未设置时跳过角色资产链路（行为与持久化角色功能上线前完全一致）。
   */
  roleId?: string;
  systemPrompt: string;
  availableTools: string[];
  /**
   * GAP-011（课程"方向 A"）：spawn 时把这些 skill 的 SKILL.md 全文拼进子代理
   * system prompt（知识注入）。与 availableTools 权限边界正交——注入 skill
   * 不扩张子代理的工具集。
   */
  skills?: string[];
  maxIterations?: number;
  /** Permission preset for pipeline integration */
  permissionPreset?: PermissionPreset;
  /** Maximum budget for this subagent */
  maxBudget?: number;
  /** P3: Maximum execution time in milliseconds */
  maxExecutionTimeMs?: number;
  /** Maximum tool call attempts allowed for this subagent */
  maxToolCalls?: number;
  /** Whether high-risk operations require plan approval from coordinator */
  requirePlanApproval?: boolean;
  /** Coordinator agent ID for plan approval (defaults to 'coordinator') */
  coordinatorId?: string;
}

export interface SubagentResult {
  success: boolean;
  output: string;
  error?: string;
  toolsUsed: string[];
  iterations: number;
  /** Cost incurred by this subagent */
  cost?: number;
  /** 本次 subagent 跨迭代累计的 outputTokens（dynamic-workflow BudgetTracker 计费用）。 */
  tokensUsed?: number;
  /** Agent ID from pipeline */
  agentId?: string;
  /** Lightweight context snapshot for swarm UI */
  contextSnapshot?: SwarmAgentContextSnapshot;
  /**
   * When success === false because of an abort, this carries the
   * cancellation reason (`user-cancel | parent-cancel | timeout |
   * idle-timeout | child-error | session-switch | budget-exceeded`).
   * Caller (spawnAgent / parallel coordinator) can route on this to
   * decide whether to retry, surface to UI, or treat as terminal.
   */
  cancellationReason?: CancellationReason;
}

export interface SubagentContext {
  modelConfig: ModelConfig;
  toolResolver: ToolResolver;
  toolContext: ToolContext;
  /** Attachments (images, files) to include in the first message */
  attachments?: Array<{
    type: string;
    category?: string;
    name?: string;
    path?: string;
    data?: string;
    mimeType?: string;
  }>;
  /** 父工具调用 ID，用于标识消息来自哪个 subagent */
  parentToolUseId?: string;
  /** AbortSignal 用于取消任务执行 */
  abortSignal?: AbortSignal;
  /** SpawnGuard agent ID — used to drain message queue for send_input */
  spawnGuardId?: string;
  /** Optional external message queue drain, used by parallel executor inboxes. */
  messageDrain?: () => AgentMessage[];
  /** External task agent ID (e.g. DAG task ID) for context observability */
  executionAgentId?: string;
  /** Parent context for child context inheritance */
  parentContext?: ParentContext;
  /** Worktree path if agent is running in an isolated git worktree */
  worktreePath?: string;
  /** Optional callback for lightweight context updates */
  onContextSnapshot?: (snapshot: SwarmAgentContextSnapshot) => void;
  /** HookManager for firing SubagentStart/Stop and TaskCreated/Completed events */
  hookManager?: HookManager;
  /**
   * 父探活回调（swarm 护栏 P1-2 #5）。仅后台 detached 子代理注入：返回 false 表示
   * 父 run 已结束/被新 run 取代，子代理应自我中止（parent-gone）避免成孤儿烧预算。
   * 未注入时不探活（前台子代理被父 await，不会成孤儿）。
   */
  isParentAlive?: () => boolean;
}
