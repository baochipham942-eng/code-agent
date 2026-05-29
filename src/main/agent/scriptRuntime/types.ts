// ============================================================================
// scriptRuntime —— Claude Code 式 dynamic-workflow 命令式脚本运行时
//
// 模型当场写 JS 编排脚本（持有 loop/branch/中间变量）→ 受限沙箱后台执行 →
// 扇出并行子 agent。本文件只放【可序列化纯数据类型】，worker 沙箱与主线程都可 import
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
}

/** worker 侧 agent() 调用 marshal 给主线程的载荷。 */
export interface AgentCallPayload {
  prompt: string;
  options?: AgentCallOptions;
}

/** agent() 的返回：无 schema = 文本；有 schema = 校验过的对象。 */
export type PrimitiveResult = string | Record<string, unknown>;

// ── worker ⇄ main RPC 协议 ──────────────────────────────────────────────────
// 不可信脚本跑在 worker；agent()/phase()/log() 是 RPC stub，序列化调用 → postMessage
// → 主线程执行重活 → 回传。parallel()/pipeline() 不单独 RPC，由 worker 侧用
// Promise 组合多个 agent RPC，真正的并发排队发生在主线程 concurrencyGate。

export type RpcKind = 'agent' | 'phase' | 'log';

export interface RpcRequest {
  /** worker 内自增调用 id，用于把响应配回对应的 pending promise。 */
  id: number;
  kind: RpcKind;
  payload: AgentCallPayload | { title: string } | { message: string };
}

export interface RpcResponse {
  id: number;
  ok: boolean;
  result?: PrimitiveResult | null;
  error?: string;
  /** agent 调用后回传的累计已花 outputTokens，worker 侧 budget.spent() 镜像据此更新。 */
  spent?: number;
}

/** worker 启动时主线程注入的初始化消息（脚本源码 + 目标 + 确定性种子）。 */
export interface WorkerInit {
  script: string;
  goal?: string;
  /** 用于 resumable 重放时按序生成确定性 call-id 的种子（worker 内 Date.now/Math.random 被禁）。 */
  callIdSeed: string;
}

/** worker 执行完毕回主线程的终态消息。 */
export interface WorkerDone {
  ok: boolean;
  /** 脚本 return 的值（须可结构化克隆）。 */
  result?: unknown;
  error?: string;
}

// ── run 生命周期 ─────────────────────────────────────────────────────────────

// RunStatus / ScriptRunEventType / ScriptRunEvent 是跨层可序列化契约，已下沉到
// @shared/contract/scriptRun（renderer 视图层也要消费，renderer 从不 import @main）。
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
}

/** run 的可观测状态快照（供 UI / resumable 用，纯可序列化）。 */
export interface ScriptRunState {
  runId: string;
  status: RunStatus;
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
  phases: string[];
}
