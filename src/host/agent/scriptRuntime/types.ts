// ============================================================================
// scriptRuntime —— Claude Code 式 dynamic-workflow 命令式脚本运行时
//
// 模型当场写 JS 编排脚本（持有 loop/branch/中间变量）→ 受限沙箱后台执行 →
// 扇出并行子 agent。本文件只放【可序列化纯数据类型】，child sandbox 与 Host 都可 import
// （类型在编译后擦除，不引入重运行时依赖）。带 ToolContext/Resolver 的运行期上下文
// 放 agentBridge.ts / runService.ts，不在此处，避免污染 worker bundle。
// ============================================================================

/** 模型脚本里 agent() 可返回的结构化值的 schema（JSON Schema 子集，透传给 forced tool_choice）。 */
export type JsonSchema = Record<string, unknown>;

/** agent(prompt, opts) 的可选项——对齐 Claude Code Workflow 的 agent() 原语。 */
export interface AgentCallOptions {
  /** 给定则走 forced tool_choice 单轮结构化输出，返回校验过的对象；否则走完整 agent loop 返回文本。 */
  schema?: JsonSchema;
  /** per-call 模型覆盖（混合模型：强模型判官 + 廉价模型扇出）。 */
  model?: { provider: string; model: string };
  /** 进度显示用标签。 */
  label?: string;
  /** 归属的 phase 分组（用于进度树）。 */
  phase?: string;
  /** 子 agent 角色类型（默认通用执行体）。 */
  agentType?: string;
  /** 工具档：'readonly'(默认) | 'edit'(+Edit/Write) | 'full'(+Bash)。仅 full-agent 路径（无 schema）生效。 */
  tools?: string;
  /** Paths or glob ranges this agent owns while it is live. */
  ownedPaths?: string[];
}

/** child 侧 agent() 调用 marshal 给 Host 的载荷。 */
export interface AgentCallPayload {
  prompt: string;
  options?: AgentCallOptions;
}

/** agent() 的返回：无 schema = 文本；有 schema = 校验过的对象。 */
export type PrimitiveResult = string | Record<string, unknown>;

/** child 侧 tools.<name>(args) marshal 给 Host 的载荷。args 必须是无损 JSON 对象。 */
export interface ToolCallPayload {
  name: string;
  args: Record<string, unknown>;
}

export interface AgentWorkspaceLease {
  cwd: string;
  workspace: string;
  repoPath: string;
  branchName: string;
  baseCommit?: string;
}

export interface AgentWorkspaceHandoff {
  agentId: string;
  status: 'cleaned' | 'preserved' | 'discarded' | 'error';
  cwd?: string;
  branchName: string;
  changedFiles?: string[];
  diffSummary?: string;
  error?: string;
}

// ── child process ⇄ Host RPC 协议 ───────────────────────────────────────────
// 不可信脚本跑在独立进程；agent()/phase()/log()/tools.<name>() 是 RPC stub。
// parallel()/pipeline() 不单独 RPC，由 child 用 Promise 组合，真正的并发排队发生在
// Host concurrencyGate。
//
// 'tool' 是 PTC（Code Mode）通道：脚本直接调工具，不必为每次调用起一个子 agent。
// 它**不新建执行路径**——Host 侧把它当成一次普通工具调用送进既有的
// pre-execute/审批/guards/execute 管线，只是入口不同（形态对齐 DeepSeek Harness
// Code Mode 的 dispatch bridge）。

/**
 * 全部合法 RPC kind 的**单一真源**。类型与 Host 侧分发白名单都从这里派生。
 *
 * 别再在别处写一份字面量数组：本单加 'tool' 时就撞到了——`sandbox.ts` 里另有一份
 * `['agent','phase','log']` 硬编码白名单，新 kind 静默变成 `unsupported primitive`，
 * 而类型检查全绿（本仓「按名字枚举的清单是漏洞制造机」第 N 次复发）。
 */
export const RPC_KINDS = ['agent', 'phase', 'log', 'tool'] as const;

export type RpcKind = (typeof RPC_KINDS)[number];

export const NESTED_GRAPH_PROTOCOL_VERSION = 'nested-graph:v1' as const;
export type NestedWorkflowGroupKind = 'single' | 'parallel' | 'pipeline';

/**
 * Versioned, credential-free identity projected by the sandbox for one nested
 * workflow RPC. Logical ids deliberately exclude attempt, pid and wall clock.
 */
export interface NestedWorkflowMetadata {
  protocolVersion: typeof NESTED_GRAPH_PROTOCOL_VERSION;
  workflowRunId: string;
  parentGraphId: string;
  parentNodeId: string;
  nestedGraphId: string;
  groupId: string;
  groupKind: NestedWorkflowGroupKind;
  itemId?: string;
  stageId?: string;
  nodeId: string;
  dependencyNodeIds: string[];
  callIndex: number;
  sideEffect: 'none' | 'read_only' | 'idempotent' | 'unknown';
  traceContext?: import('../../telemetry/runTraceContext').SerializedRunTraceContext;
}

export interface NestedWorkflowIdentity {
  protocolVersion: typeof NESTED_GRAPH_PROTOCOL_VERSION;
  workflowRunId: string;
  parentGraphId: string;
  parentNodeId: string;
  nestedGraphId: string;
  scriptHash: string;
}

export interface NestedGraphEvent {
  type: 'nested:node_started' | 'nested:node_completed' | 'nested:node_failed';
  metadata: NestedWorkflowMetadata;
  timestamp: number;
  cached?: boolean;
  resultRef?: string;
  error?: string;
}

export interface RpcRequest {
  /** child 内自增调用 id，用于把响应配回对应的 pending promise。 */
  id: number;
  kind: RpcKind;
  payload: AgentCallPayload | ToolCallPayload | { title: string } | { message: string };
  /** Child-created W3C context for this RPC node. Contains no prompt or credential values. */
  traceContext?: import('../../telemetry/runTraceContext').SerializedRunTraceContext;
  /** Missing means legacy compatibility mode and must never be treated as recoverable. */
  metadata?: NestedWorkflowMetadata;
}

export interface RpcResponse {
  id: number;
  ok: boolean;
  /**
   * agent/phase/log 路径回 `PrimitiveResult | null`；tool 路径回工具的产出值本身
   * （任意无损 JSON，不做二次包装）。故这里是 unknown——别为「工具产出」另起一个
   * 类型别名，`X | unknown` 会被折叠成 unknown，名字不带来任何约束只带来一个死导出。
   */
  result?: unknown;
  error?: string;
  /** agent 调用后回传的累计已花 outputTokens，child 侧 budget.spent() 镜像据此更新。 */
  spent?: number;
  /**
   * 失败的工具名。仅 kind==='tool' 的失败响应带它——child 侧据此把 reject 造成
   * `ToolCallError`（带 toolName）而不是裸 Error，脚本才能 try/catch 后继续跑。
   */
  toolName?: string;
}

// 注：child 的初始化/终态消息形状由 sandbox.ts 内联定义。
// resumable（P4）的确定性 call-id 走「位置序 callCounter（声明序，单线程确定）+ prompt/opts 内容
// hash」方案，不需要随机种子——故不再保留 WorkerInit.callIdSeed 这类前置空壳。

// ── run 生命周期 ─────────────────────────────────────────────────────────────

// RunStatus / ScriptRunEventType / ScriptRunEvent 是跨层可序列化契约，已下沉到
// @shared/contract/scriptRun（renderer 视图层也要消费，renderer 从不 import @host）。
// 此处 re-export 保持 main 侧既有 importer 零改动。
export type { RunStatus, ScriptRunEventType, ScriptRunEvent } from '../../../shared/contract/scriptRun';
import type { RunStatus } from '../../../shared/contract/scriptRun';

export interface ScriptMeta {
  name: string;
  description: string;
  phases?: Array<{ title: string; detail?: string }>;
}

/** 一次 dynamic-workflow run 的规格（由 /workflow 命令层构造并交给 runService.startRun）。 */
export interface ScriptRunSpec {
  runId: string;
  /** 归属会话，用于控制面授权和 renderer 会话隔离。 */
  sessionId?: string;
  /** run 的工作目录（宿主从 toolContext 注入）。取消/丢弃时用于抢救文件改动成 patch。 */
  workingDir?: string;
  /** 模型当场写的 JS 编排脚本源码。 */
  script: string;
  /** /workflow <goal> 的任务目标。 */
  goal?: string;
  /** 默认 provider（per-call 未覆盖时用）。 */
  defaultProvider: string;
  /** 默认模型。 */
  defaultModel: string;
  /** token 预算上限（outputTokens）。给定则硬上限：耗尽后 agent() 抛错。不给 = 不设限。 */
  budgetTokens?: number;
  /** resumable：从这个旧 run 的 journal 重放——重跑确定性脚本，命中缓存的 agent() 瞬时返回不再 inference。 */
  resumeFromRunId?: string;
  /** Parent Graph identity used to derive the sandbox-owned nested graph. */
  nestedGraph?: NestedWorkflowIdentity;
}

/** 一次成功 agent() 调用写入 journal 的记录（resumable 缓存的最小单元）。 */
export interface ScriptRunCallRecord {
  /** 位置序 call-id（声明序、单线程确定），= callCounter 自增后的值。 */
  callIndex: number;
  /** prompt + 语义 opts + resolved model + run goal/args 上下文的内容 hash；重放时与旧 journal 比对决定命中/失效。 */
  contentHash: string;
  result: PrimitiveResult;
  tokensUsed: number;
  label?: string;
  ts: number;
}

/** run 的可观测状态快照（供 UI / resumable 用，纯可序列化）。 */
export interface ScriptRunState {
  runId: string;
  status: RunStatus;
  /** 归属会话，用于 cancel/pause/resume 等控制面授权。 */
  sessionId?: string;
  /** 脚本源码 hash——resumable 重放时校验脚本未变。 */
  scriptHash: string;
  startedAt: number;
  finishedAt?: number;
  /** 脚本 return 的最终结果。 */
  result?: unknown;
  error?: string;
  agentCallCount: number;
  /** 全 run 累计已花 outputTokens（预算账本终值）。 */
  tokensSpent: number;
  /** resumable 命中缓存的 agent() 次数（0 = 未命中任何缓存 / 非 resume run）。供「resume 是否生效」观测。 */
  cacheHits: number;
  phases: string[];
  /** writer worktree 的 merge/review 交接，不含自动 merge 动作。 */
  handoffs?: AgentWorkspaceHandoff[];
}
