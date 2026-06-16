// ============================================================================
// Model Decision Contract - shared event payload for ADR-019 routing trace.
// ============================================================================

import type {
  AgentEngineCapability,
  AgentEngineFailureDiagnostics,
  AgentEngineInstallState,
  AgentEngineReliability,
  AgentEngineRuntimeState,
  ExternalAgentEngineKind,
} from './agentEngine';
import type { ModelProviderProtocol } from './model';

/** Provider 计费方式（ADR-019 决策 4：计费语义四分类） */
export type BillingMode = 'free' | 'plan' | 'payg' | 'unknown';

/** 决策原因，UI trace 文案和日志都从这里派生 */
export type ModelDecisionReason =
  | 'user-selected'
  | 'default-model'
  | 'role-tier'
  | 'simple-task-free'
  | 'billing-gate-skip'
  | 'strategy-fast'
  | 'strategy-main'
  | 'strategy-deep'
  | 'strategy-vision'
  | 'capability-vision'
  | 'fallback-availability';

/** 当前轮主要任务形态，供会话页解释"为什么这个模型合适" */
export type ModelTaskClass =
  | 'simple'
  | 'coding'
  | 'vision'
  | 'search'
  | 'artifact'
  | 'long-context'
  | 'multi-tool'
  | 'unknown';

/** 成本侧策略，不等于真实账单，只表达本轮路由为什么省/不省 */
export type ModelCostPolicy =
  | 'save-cost'
  | 'plan-no-savings'
  | 'unknown-conservative'
  | 'user-locked'
  | 'neutral';

/** 速度侧策略，表达是否为了降低延迟走快模型 */
export type ModelSpeedPolicy =
  | 'fast-path'
  | 'normal'
  | 'provider-degraded'
  | 'fallback-recovery';

/** 工具侧策略，表达工具能力是否交给执行链路复核 */
export type ModelToolPolicy =
  | 'runtime-checked'
  | 'disabled-by-model'
  | 'unknown';

export type ProgrammaticToolCallingStatus = 'available' | 'unavailable';

export type ToolTokenSavingsStatus = 'not-measured' | 'estimated' | 'provider-reported';

export type ToolTokenSavingsBasisSource = 'tool-spec-local-estimate';

export type ToolTokenSavingsProviderUsageSource = 'model-response-usage';
export type ToolTokenSavingsProviderReportSource = 'provider-reported';
export type ToolTokenSavingsMeasurementSource = 'tool-spec-local-estimate' | ToolTokenSavingsProviderReportSource | 'not-measured';
export type ToolTokenSavingsUsageSource = ToolTokenSavingsProviderUsageSource | 'unavailable';

export interface ModelToolTokenSavingsBasis {
  source: ToolTokenSavingsBasisSource;
  toolCount: number;
  previewToolCount?: number;
  fields: Array<'name' | 'description' | 'inputSchema'>;
}

export interface ModelToolTokenSavingsProviderUsage {
  source: ToolTokenSavingsProviderUsageSource;
  inputTokens: number;
  outputTokens: number;
  totalTokens?: number;
}

export interface ModelToolTokenSavingsProviderReport {
  source: ToolTokenSavingsProviderReportSource;
  savedTokens: number;
}

export interface ModelToolTokenSavingsMeasurement {
  /** savedTokens 的来源；local estimate 表示本地按工具规格粗估，不是 provider 账单字段。 */
  savingsSource: ToolTokenSavingsMeasurementSource;
  /** 本轮 usage 来源；有 usage 也只说明本轮消耗，不说明 saved tokens。 */
  usageSource: ToolTokenSavingsUsageSource;
  /** 当前是否拿到了 provider 明确回传的 saved-token 差值。 */
  providerReportedSavings: boolean;
}

export interface ModelToolTokenSavings {
  status: ToolTokenSavingsStatus;
  /** estimated 表示本地估算；provider-reported 表示 provider/tool 层明确回传的 saved-token 差值。 */
  savedTokens?: number;
  detail?: string;
  measurement?: ModelToolTokenSavingsMeasurement;
  basis?: ModelToolTokenSavingsBasis;
  /** provider/tool 层明确回传的 saved-token 差值；只有存在此字段时才能当作 provider-reported。 */
  providerReport?: ModelToolTokenSavingsProviderReport;
  /** provider/model response 回传的本轮真实 usage；用于校准成本语境，不等同于 saved tokens。 */
  providerUsage?: ModelToolTokenSavingsProviderUsage;
}

/** 本轮真实下发给模型的工具策略快照，来自 runtime effectiveTools */
export interface ModelToolStrategyDiagnostics {
  visibleToolCount: number;
  toolNamesPreview?: string[];
  mcpToolCount: number;
  mcpServerIds?: string[];
  programmaticToolCalling: ProgrammaticToolCallingStatus;
  programmaticToolCount: number;
  tokenSavings?: ModelToolTokenSavings;
}

/** 本轮决策显式识别到的能力需求 */
export type ModelCapabilityNeed =
  | 'vision'
  | 'code'
  | 'search'
  | 'artifact'
  | 'long-context'
  | 'tool-use';

/** Provider 最近窗口健康状态；unknown 表示本地还没有样本 */
export type ModelProviderHealthStatus =
  | 'healthy'
  | 'degraded'
  | 'unavailable'
  | 'recovering'
  | 'unknown';

/** 决策时采样到的 provider 健康窗口 */
export interface ModelProviderHealthSnapshot {
  provider: string;
  status: ModelProviderHealthStatus;
  sampledAt: number;
  latencyP50?: number;
  latencyP95?: number;
  errorRate?: number;
  lastSuccessAt?: number;
  lastErrorAt?: number;
  consecutiveErrors?: number;
}

/** 决策时 resolved provider 的身份信息；用于会话页说明这轮跑在哪条 provider 链路上。 */
export interface ModelProviderIdentity {
  provider: string;
  displayName?: string;
  /** 对 custom relay / 中转站暴露真实来源，避免 icon 或 canonical group 掩盖身份。 */
  sourceLabel?: string;
  protocol?: ModelProviderProtocol;
  transportLabel?: string;
  endpoint?: string;
}

/** 外部/订阅 Agent Engine 的本轮链路快照，供会话页解释 CLI、auth、quota、stream 和工具可靠性。 */
export interface ModelExternalEngineSnapshot {
  kind: ExternalAgentEngineKind;
  label: string;
  model?: string;
  installState: AgentEngineInstallState;
  runtimeState: AgentEngineRuntimeState;
  executable: boolean;
  capabilities: AgentEngineCapability[];
  reliability?: AgentEngineReliability;
  failure?: AgentEngineFailureDiagnostics;
  command?: string;
  version?: string;
}

/** fallback 链路里的单个候选状态，供会话页解释降级过程 */
export type ModelFallbackTraceStatus = 'tried' | 'skipped' | 'selected' | 'exhausted';

export interface ModelFallbackTraceStep {
  provider: string;
  model?: string;
  /** 可选 provider 身份；用于 fallback banner 展示 relay/source/protocol/endpoint。 */
  providerIdentity?: ModelProviderIdentity;
  status: ModelFallbackTraceStatus;
  /** 机器可聚合的原因，如 missing_api_key / provider_unavailable / fallback_failed */
  reason: string;
  /** provider fallback 分类，如 timeout / quota / network */
  category?: string;
  /** 面向用户和调试的短说明，必须避免塞完整报错堆栈 */
  detail?: string;
}

export interface ModelFallbackToolPolicy {
  status: 'disabled';
  reason: 'fallback_model_without_tool_support';
  originalToolCount: number;
  effectiveToolCount: number;
  disabledToolNames?: string[];
  detail?: string;
}

export type ModelFallbackStrategy =
  | 'adaptive-provider-fallback'
  | 'adaptive-capability-fallback'
  | 'adaptive-main-task-recovery';

export interface ModelFallbackInfo {
  from: { provider: string; model?: string };
  to: { provider: string; model?: string };
  fromIdentity?: ModelProviderIdentity;
  toIdentity?: ModelProviderIdentity;
  reason: string;
  category: string;
  strategy?: ModelFallbackStrategy;
  tried?: ModelFallbackTraceStep[];
  skipped?: ModelFallbackTraceStep[];
  toolPolicy?: ModelFallbackToolPolicy;
}

/** 结构化路由决策，main / renderer / telemetry 共用 */
export interface ModelDecision {
  requestedProvider: string;
  requestedModel: string;
  resolvedProvider: string;
  resolvedModel: string;
  /** subagent 角色（explore/coder 等），主聊天为 null */
  role: string | null;
  reason: ModelDecisionReason;
  billingMode: BillingMode;
  /** 可用性降级时记录降级前的模型，其余为 null */
  fallbackFrom: string | null;
  /** UI 可直接展示的一句话策略解释 */
  strategySummary?: string;
  /** AdaptiveRouter 的复杂度分数；非 adaptive 路径可能不存在 */
  complexityScore?: number;
  /** 当前轮任务类型，用于解释主任务模型选择 */
  taskClass?: ModelTaskClass;
  /** 成本/订阅/按量相关路由策略 */
  costPolicy?: ModelCostPolicy;
  /** 速度相关路由策略 */
  speedPolicy?: ModelSpeedPolicy;
  /** 工具能力策略；具体禁用/降级仍以运行时事件为准 */
  toolPolicy?: ModelToolPolicy;
  /** 本轮实际工具/MCP/程序化调用可用性，来自 runtime effectiveTools */
  toolStrategy?: ModelToolStrategyDiagnostics;
  /** 已识别能力需求，供会话页解释和遥测聚合 */
  capabilityNeeds?: ModelCapabilityNeed[];
  /** 决策时 resolved provider 的最近健康窗口 */
  providerHealthSnapshot?: ModelProviderHealthSnapshot;
  /** 决策时 resolved provider 的来源、协议和 endpoint 身份 */
  providerIdentity?: ModelProviderIdentity;
  /** 外部 engine / 订阅模型链路状态；native provider 决策通常为空 */
  externalEngine?: ModelExternalEngineSnapshot;
  /** 任务策略 profile。为空表示沿用 legacy 用户选择 / 角色档位路径。 */
  strategyProfile?: 'fast' | 'main' | 'deep' | 'vision';
  /** 命中的任务策略规则 ID。 */
  strategyRuleId?: string;
  /** 给 UI/Replay 展示的策略解释。 */
  strategyReason?: string;
  taskComplexity?: {
    level: 'simple' | 'moderate' | 'complex';
    score: number;
    signals: string[];
  };
}

export interface ModelDecisionEventData extends ModelDecision {
  turnId?: string;
  timestamp?: number;
}
