import type { Message, ModelConfig, PermissionPreset, ToolDefinition } from '../../shared/contract';
import type { SwarmAgentContextSnapshot, SwarmRunScope } from '../../shared/contract/swarm';
import type { CancellationReason } from '../../shared/contract/cancellation';
import type { AgentFailureCode } from '../../shared/contract/agentFailure';
import type { RunTraceContext } from '../telemetry/runTraceContext';
import type { ExecutionTopology } from '../permissions/guardFabric';
import type { AgentMessage } from './spawnGuard';
import type { ParentContext } from './childContext';
import type { CapabilityManifest } from '../../shared/contract/agentCapabilities';
import type {
  ConversationExecutionIntent,
  WorkbenchToolScope,
} from '../../shared/contract/conversationEnvelope';

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
  failureCode?: AgentFailureCode;
}

export interface SubagentToolResolverPort {
  getDefinition(name: string): ToolDefinition | undefined;
}

export interface SubagentPermissionRequest {
  sessionId?: string;
  forceConfirm?: boolean;
  type: 'file_read' | 'file_write' | 'file_edit' | 'command' | 'network' | 'dangerous_command';
  tool: string;
  details: Record<string, unknown>;
  reason?: string;
  reasonCode?: string;
  boundary?: unknown;
  dangerLevel?: 'normal' | 'warning' | 'danger';
  decisionTrace?: unknown;
}

export interface SubagentPermissionPort {
  request(request: SubagentPermissionRequest): Promise<boolean>;
}

export interface SubagentHookPort {
  triggerTaskCreated(taskId: string, agentType: string, sessionId: string): Promise<unknown>;
  triggerTaskCompleted(taskId: string, agentType: string, success: boolean, sessionId: string): Promise<unknown>;
  triggerSubagentStart(
    agentType: string,
    agentId: string,
    prompt: string,
    sessionId: string,
    parentToolUseId?: string,
  ): Promise<unknown>;
  triggerSubagentStop(
    agentType: string,
    output: string | undefined,
    sessionId: string,
    agentId?: string,
  ): Promise<unknown>;
}

export interface SubagentEventPort {
  emit(event: string, data: unknown): void;
  progress?(stage: 'starting' | 'running' | 'completing', detail?: string, percent?: number): void;
}

export interface SubagentAttachment {
  type: string;
  category?: string;
  name?: string;
  path?: string;
  data?: string;
  mimeType?: string;
}

export interface SubagentExecutionContext {
  /** Native run identity; never inferred from a process singleton. */
  runId?: string;
  /**
   * GuardFabric 拓扑标注（2026-07-13 激活批）：构造点显式声明该子 agent 的执行拓扑，
   * subagentToolRuntime 透传给 ToolExecutor。缺省 = 'main'（无 TOPOLOGY_RULES 约束，
   * 与激活前行为一致）。
   */
  executionTopology?: ExecutionTopology;
  sessionId: string;
  workspace?: string;
  cwd: string;
  modelConfig: ModelConfig;
  resolver: SubagentToolResolverPort;
  permission: SubagentPermissionPort;
  hooks?: SubagentHookPort;
  events: SubagentEventPort;
  abortSignal: AbortSignal;
  traceContext?: RunTraceContext;
  currentToolCallId?: string;
  agentId?: string;
  agentName?: string;
  agentRole?: string;
  messages?: Message[];
  modifiedFiles?: Set<string>;
  todos?: Array<{
    id: string;
    content: string;
    status: 'pending' | 'in_progress' | 'completed' | 'cancelled';
  }>;
  spawnDepth?: number;
  spawnMaxDepth?: number;
  spawnTreeId?: string;
  swarmRunScope?: SwarmRunScope;
  parentNativeRunId?: string;
  spawnQueueTimeoutMs?: number;
  spawnParentStartedAt?: number;
  spawnParentTimeoutMs?: number;
  spawnParentAgentId?: string;
  toolScope?: WorkbenchToolScope;
  executionIntent?: ConversationExecutionIntent;
  /** Attachments (images, files) to include in the first message */
  attachments?: SubagentAttachment[];
  /** 父工具调用 ID，用于标识消息来自哪个 subagent */
  parentToolUseId?: string;
  /** SpawnGuard agent ID — used to drain message queue for send_input */
  spawnGuardId?: string;
  /** Optional external message queue drain, used by parallel executor inboxes. */
  messageDrain?: () => AgentMessage[] | Promise<AgentMessage[]>;
  /** External task agent ID (e.g. DAG task ID) for context observability */
  executionAgentId?: string;
  /** Parent context for child context inheritance */
  parentContext?: ParentContext;
  /** Parent agent remaining budget used to cap this subagent budget. */
  parentRemainingBudget?: number;
  /** Suppress idle parent wakeups for background subagents spawned from controlled loops. */
  suppressBackgroundSubagentIdleWake?: boolean;
  /** Worktree path if agent is running in an isolated git worktree */
  worktreePath?: string;
  /** 该 child 实际获授的能力快照；只描述权限，不携带 credential 值。 */
  capabilityManifest?: Readonly<CapabilityManifest>;
  /** Optional callback for lightweight context updates */
  onContextSnapshot?: (snapshot: SwarmAgentContextSnapshot) => void;
  /**
   * 父探活回调（swarm 护栏 P1-2 #5）。仅后台 detached 子代理注入：返回 false 表示
   * 父 run 已结束/被新 run 取代，子代理应自我中止（parent-gone）避免成孤儿烧预算。
   * 未注入时不探活（前台子代理被父 await，不会成孤儿）。
   */
  isParentAlive?: () => boolean;
}

export interface SubagentExecutionRequest {
  prompt: string;
  config: SubagentConfig;
  context: SubagentExecutionContext;
}

/** @deprecated Use SubagentExecutionContext. Kept as a source-compatible name only. */
export type SubagentContext = SubagentExecutionContext;
