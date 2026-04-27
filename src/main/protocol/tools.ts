// ============================================================================
// Protocol — Tool Schema Registry 接口定义
//
// 对齐 Claude Code CLI 2.1.88 leaked Tool.ts 的 4 参数签名：
//   call(args, context, canUseTool, parentMessage?, onProgress?)
//
// 设计要点（和 Codex/CC 对照）：
// 1. schema 和 handler 分开：schema 是纯声明，启动时全量注册；handler 是 lazy
//    构造的可执行体，首次调用时才实例化（支持 API client 懒加载）
// 2. ctx 承载"状态性依赖"（logger、cache、identity），不是所有依赖都塞进去
// 3. canUseTool 是独立参数而不是 ctx 字段。理由：权限策略可按 turn 变化（plan
//    模式切 code 模式），作为 closure 传入比作为 ctx mutable state 更安全
// 4. onProgress 独立参数。tool→UI 的反向进度流和 agent→UI 的正向事件流分开
// 5. protocol/tools.ts 不 import 任何业务模块（agent/tools/services/ipc/...）
//    只依赖 @shared/contract 和本层 protocol/events
// ============================================================================

import type { JSONSchema } from '@shared/contract';
import type {
  ConversationExecutionIntent,
  WorkbenchToolScope,
} from '@shared/contract/conversationEnvelope';
import type { AgentEvent } from './events';

// ----------------------------------------------------------------------------
// Schema 层 — 纯声明，启动时全量注册
// ----------------------------------------------------------------------------

export type ToolCategory =
  | 'fs'
  | 'shell'
  | 'network'
  | 'multiagent'
  | 'planning'
  | 'skill'
  | 'vision'
  | 'document'
  | 'excel'
  | 'mcp'
  | 'lsp';

export type PermissionLevel = 'read' | 'write' | 'execute' | 'network' | 'dangerous';

export interface ToolSchema {
  readonly name: string;
  readonly description: string;
  /** 动态描述，运行时计算（例如注入当前日期）。有则优先于 description */
  readonly dynamicDescription?: () => string;
  readonly inputSchema: JSONSchema;
  readonly category: ToolCategory;
  readonly permissionLevel: PermissionLevel;
  /**
   * 声明依赖哪些 API key。Registry 启动时可做预校验，缺失则 schema 自动降级或标灰。
   * 例：['PERPLEXITY_API_KEY', 'EXA_API_KEY']（任一满足即可）
   */
  readonly requiresApiKey?: readonly string[];
  /** 幂等 hint（read-only tool），用于缓存和 plan-mode 判断 */
  readonly readOnly?: boolean;
  /** 是否可在 plan mode 下使用（read-only + 不触发外部副作用） */
  readonly allowInPlanMode?: boolean;
}

// ----------------------------------------------------------------------------
// Handler 层 — 首次调用 lazy 构造
// ----------------------------------------------------------------------------

export interface ToolHandler<Args = Record<string, unknown>, Output = unknown> {
  readonly schema: ToolSchema;
  execute(
    args: Args,
    ctx: ToolContext,
    canUseTool: CanUseToolFn,
    onProgress?: ToolProgressFn,
  ): Promise<ToolResult<Output>>;
}

/**
 * 每个 tool 文件 export 的形态。Registry 通过 dynamic import 拉这个模块。
 * createHandler 可同步或异步 — 需要 init API client 的走 async。
 * 泛型默认 Record<string, unknown>/unknown，特化模块可声明精确参数类型。
 */
export interface ToolModule<Args = Record<string, unknown>, Output = unknown> {
  readonly schema: ToolSchema;
  createHandler(): ToolHandler<Args, Output> | Promise<ToolHandler<Args, Output>>;
}

// ----------------------------------------------------------------------------
// Context — 注入的只读依赖（对应 CC ToolUseContext 瘦身版）
// ----------------------------------------------------------------------------

export interface ToolContext {
  readonly sessionId: string;
  readonly workingDir: string;
  readonly abortSignal: AbortSignal;

  /** 轻量 logger 接口，不耦合 services/infra/logger 实现 */
  readonly logger: Logger;

  // --- Agent/Subagent 身份（CC agentId/agentType 对应）---
  readonly agentId?: string;
  readonly agentType?: string;

  // --- 文件读取缓存（CC readFileState 对应）---
  readonly fileCache?: FileReadCache;

  // --- 工具决策历史（CC toolDecisions 对应，做幂等和重复检测）---
  readonly toolDecisions?: ReadonlyMap<string, ToolDecision>;

  /** 发射 AgentEvent 到 UI/IPC（CC addNotification/setToolJSX 归一版）*/
  emit(event: AgentEvent): void;

  // --------------------------------------------------------------------------
  // P0-5 全量迁移所需字段（P0-5 ctx 扩展，2026-04-12）
  //
  // 设计原则：
  // 1. 纯函数类型 / 简单接口 → 直接结构化定义在本文件
  // 2. 业务 service（hookManager/planningService 等）→ 用 unknown opaque
  //    避免 protocol 层 import 业务模块，生产 tool 在使用点做 cast
  // 3. 全部 optional：POC 工具不需要的字段不用知道存在
  // --------------------------------------------------------------------------

  /** 工具内二次调用模型（PPT/WebFetch 等需要） */
  readonly modelCallback?: ModelCallbackFn;

  /** 当前 tool_use 的 ID，subagent 追踪用 */
  readonly currentToolCallId?: string;

  /** Plan mode 控制器，给 EnterPlanMode/ExitPlanMode 用 */
  readonly planMode?: PlanModeController;

  /** subagent 上下文 snapshot（仅当 tool 在 subagent 内运行时设置）*/
  readonly subagent?: SubagentSnapshot;

  // ── opaque service handles（业务类型不导出到 protocol，cast at use site）──
  /** HookManager 引用，用 cast: `ctx.hookManager as HookManager` */
  readonly hookManager?: unknown;
  /** PlanningService 引用，用 cast: `ctx.planningService as PlanningService` */
  readonly planningService?: unknown;
  /** ModelConfig 引用，用 cast: `ctx.modelConfig as ModelConfig` */
  readonly modelConfig?: unknown;

  /**
   * ToolResolver 引用（用 cast: `ctx.resolver as ToolResolver`）。
   * 工具内需要调度兄弟工具（例如 DocEdit → ppt_edit）或 spawn subagent 时，
   * 走 ctx.resolver 而不是 import 单例——避免硬耦合到 dispatch 单例并方便测试
   * 注入 mock。
   */
  readonly resolver?: unknown;
  /** 当前 turn 的显式工具作用域 */
  readonly toolScope?: WorkbenchToolScope;
  /** 当前 turn 的结构化执行意图 */
  readonly executionIntent?: ConversationExecutionIntent;
}

// ----------------------------------------------------------------------------
// 新字段类型定义
// ----------------------------------------------------------------------------

export type ModelCallbackFn = (prompt: string) => Promise<string>;

export interface PlanModeController {
  isActive(): boolean;
  enter(reason?: string): void;
  exit(reason?: string): void;
}

export interface SubagentSnapshot {
  readonly agentId?: string;
  readonly agentName?: string;
  readonly agentRole?: string;
  readonly parentSessionId?: string;
  readonly currentToolCallId?: string;
  readonly modifiedFiles?: ReadonlySet<string>;
  // messages/todos/attachments 是 unknown[] —— 协议层不知道 Message/Todo/Attachment
  // 类型（在 shared/contract，不应被 protocol 反向 import）。生产 tool cast 后用。
  readonly messages?: readonly unknown[];
  readonly todos?: readonly unknown[];
  readonly attachments?: readonly unknown[];
}

export interface Logger {
  debug(msg: string, meta?: unknown): void;
  info(msg: string, meta?: unknown): void;
  warn(msg: string, meta?: unknown): void;
  error(msg: string, meta?: unknown): void;
}

export interface FileReadCache {
  get(absPath: string): { content: string; mtimeMs: number } | undefined;
  set(absPath: string, content: string, mtimeMs: number): void;
}

export interface ToolDecision {
  toolName: string;
  input: Record<string, unknown>;
  timestamp: number;
  result: 'allow' | 'deny';
}

// ----------------------------------------------------------------------------
// 权限闭包 — 独立参数，非 ctx 字段
// ----------------------------------------------------------------------------

export interface CanUseToolRequestHint {
  readonly sessionId?: string;
  readonly forceConfirm?: boolean;
  readonly type?: 'file_read' | 'file_write' | 'file_edit' | 'command' | 'network' | 'dangerous_command';
  readonly tool?: string;
  readonly details?: Record<string, unknown>;
  readonly reason?: string;
  readonly dangerLevel?: 'normal' | 'warning' | 'danger';
  readonly decisionTrace?: unknown;
}

export type CanUseToolFn = (
  toolName: string,
  input: Record<string, unknown>,
  reason?: string,
  requestHint?: CanUseToolRequestHint,
) => Promise<CanUseToolResult>;

export type CanUseToolResult =
  | { allow: true }
  | { allow: false; reason: string };

// ----------------------------------------------------------------------------
// 进度回调 — 独立参数，非 ctx 字段
// ----------------------------------------------------------------------------

export type ToolProgressFn = (progress: ToolProgress) => void;

export interface ToolProgress {
  stage: 'starting' | 'running' | 'completing';
  percent?: number;
  detail?: string;
}

// ----------------------------------------------------------------------------
// 执行结果
// ----------------------------------------------------------------------------

export type ToolResult<Output = unknown> =
  | { ok: true; output: Output; meta?: Record<string, unknown> }
  | { ok: false; error: string; code?: string; meta?: Record<string, unknown> };

// ----------------------------------------------------------------------------
// Registry 接口（main/tools/registry.ts 实现）
// ----------------------------------------------------------------------------

export interface ToolRegistry {
  /** 启动时注册 schema + 懒加载 loader。幂等 */
  register(schema: ToolSchema, loader: ToolLoader): void;

  /** 返回所有已注册 schema，用于生成 LLM 可见的 tool 列表 */
  getSchemas(): readonly ToolSchema[];

  /** 按权限/模式过滤 schema（CC getTools 对应）*/
  getSchemasForMode(opts: ToolFilterOptions): readonly ToolSchema[];

  /** 首次调用时 lazy 加载 handler 并缓存实例 */
  resolve(name: string): Promise<ToolHandler>;

  /** 是否已注册 */
  has(name: string): boolean;

  /** 注销一个已注册工具（用于插件卸载/热重载）。返回是否实际删除 */
  unregister(name: string): boolean;

  /** 测试/热重载用 */
  reset(): void;
}

// ToolLoader 返回具体 tool 模块。用 unknown 泛型参数接纳任意特化形态 —
// 运行时 execute 前由 handler 内部做参数校验与窄化。
export type ToolLoader = () => Promise<ToolModule<Record<string, unknown>, unknown>>;

export interface ToolFilterOptions {
  /** 仅返回 readOnly === true 的 tool（plan mode）*/
  readOnly?: boolean;
  /** 仅返回指定分类 */
  categories?: readonly ToolCategory[];
  /** 按名称黑名单过滤（对应 CC filterToolsByDenyRules）*/
  deny?: ReadonlySet<string>;
}

// ----------------------------------------------------------------------------
// Tool behavior / data shapes
// P0-5 phase C: sink these "data shape" types out of tools/ so consumers
// (agent/runtime/*, context/*) import contracts from protocol — even though
// the runtime implementations necessarily stay in tools/ because they hold
// module-scoped singletons.
// ----------------------------------------------------------------------------

/**
 * Execution phase classification for a tool call.
 * Used by agent telemetry + plan-mode gating.
 *
 * - `explore`: read-only, information gathering
 * - `edit`: modifies files
 * - `execute`: runs commands or spawns subagents
 * - `other`: planning, memory, MCP, etc.
 */
export type ExecutionPhase = 'explore' | 'edit' | 'execute' | 'other';

/**
 * Structured data fingerprint for xlsx/csv/etc.
 * Anchors tool output so later turns can't hallucinate row counts or columns.
 * Runtime store lives in tools/dataFingerprint.ts.
 */
export interface DataFingerprint {
  filePath: string;
  readTime: number;
  sheetName?: string;
  rowCount: number;
  columnNames: string[];
  /** 列名 → 首行值 */
  sampleValues: Record<string, string>;
  numericRanges?: Record<string, { min: number; max: number }>;
  /** 低基数列（≤20 unique）→ 唯一值列表 */
  categoricalValues?: Record<string, string[]>;
  /** 列名 → 空值计数 */
  nullCounts?: Record<string, number>;
  /** 完全重复的行数 */
  duplicateRowCount?: number;
}

/**
 * Lightweight tool fact extracted from bash/web_fetch/etc. outputs.
 * Injected into compaction recovery as ground truth.
 */
export interface ToolFact {
  /** 工具名或文件路径 */
  source: string;
  readTime: number;
  /** 关键事实文本（每条 < 100 字） */
  facts: string[];
}
