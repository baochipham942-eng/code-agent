import React from 'react';
import { Eye, Wrench, Brain, Cpu, Terminal, Code2, Gauge } from 'lucide-react';
import type { BillingMode, ModelProvider, ModelProviderProtocol } from '@shared/contract';
import type {
  AgentEngineModelCatalogModel,
  AgentEngineDescriptor,
  AgentEngineFailureDiagnostics,
  AgentEngineKind,
  AgentEngineSessionMetadata,
  ExternalAgentEngineKind,
} from '@shared/contract/agentEngine';
import { isProviderImageIcon, type RuntimeModelFeature, type RuntimeModelOptionGroup } from '@shared/modelRuntime';
import {
  getEngineBillingMode,
  getEngineModelCompat,
  type EngineBillingMode,
  type EngineModelCompatContext,
  type EngineModelCompatReasonCode,
} from '@shared/constants/engineCompat';
import type { Translations } from '../../i18n';
import type { EffortLevel } from '../../../shared/contract/agent';
import { getProviderLogoBadge, getProviderLogoMark } from './providerLogoCatalog';
import { useProviderIconImageSource } from '../../utils/providerIconAssets';

export const QUICK_SWITCH_PROVIDERS = [
  'moonshot',
  'xiaomi',
  'longcat',
  'deepseek',
  'zhipu',
  'openai',
  'claude',
  'gemini',
  'qwen',
  'minimax',
  'openrouter',
  'perplexity',
  'grok',
  'volcengine',
  'local',
  'custom',
] as const satisfies readonly ModelProvider[];

export const ENGINE_SHORT_LABEL: Record<AgentEngineKind, string> = {
  native: 'Neo',
  codex_cli: 'Codex',
  claude_code: 'Claude',
  mimo_code: 'MiMo',
  kimi_code: 'Kimi',
};

export const ENGINE_ICON: Record<AgentEngineKind, React.ReactNode> = {
  native: <Cpu className="w-3 h-3" />,
  codex_cli: <Terminal className="w-3 h-3" />,
  claude_code: <Terminal className="w-3 h-3" />,
  mimo_code: <Terminal className="w-3 h-3" />,
  kimi_code: <Terminal className="w-3 h-3" />,
};

export const ENGINE_INSTALL_LABEL: Record<AgentEngineDescriptor['installState'], string> = {
  builtin: '内置',
  installed: '已安装',
  missing: '未安装',
};

export const ENGINE_RUNTIME_LABEL: Record<AgentEngineDescriptor['runtimeState'], string> = {
  ready: 'Ready',
  not_configured: 'Needs config',
  blocked: 'Blocked',
  error: 'Error',
  unknown: 'Unknown',
};

export const ENGINE_PERMISSION_LABEL: Record<AgentEngineDescriptor['defaultPermissionProfile'], string> = {
  default: '默认权限',
  read_only: '只读默认',
  workspace_write: '工作目录可写',
};

const ENGINE_RISK_LABEL: Record<AgentEngineDescriptor['riskTier'], string> = {
  low: '低风险',
  medium: '中风险',
  high: '高风险',
};

const ENGINE_CLI_STATUS_LABEL: Record<NonNullable<AgentEngineDescriptor['reliability']>['cliStatus'], string> = {
  available: 'CLI 可用',
  missing: 'CLI 缺失',
  error: 'CLI 异常',
  not_checked: 'CLI 未检测',
};

const ENGINE_AUTH_STATE_LABEL: Record<NonNullable<AgentEngineDescriptor['reliability']>['authState'], string> = {
  authenticated: '已登录',
  needs_login: '需登录',
  not_checked: '登录未检测',
  unknown: '登录未知',
};

const ENGINE_QUOTA_STATE_LABEL: Record<NonNullable<AgentEngineDescriptor['reliability']>['quotaState'], string> = {
  available: 'quota 可用',
  limited: 'quota 受限',
  exhausted: 'quota 耗尽',
  not_checked: 'quota 未检测',
  unknown: 'quota 未知',
};

const ENGINE_STREAMING_MODE_LABEL: Record<NonNullable<AgentEngineDescriptor['reliability']>['streamingMode'], string> = {
  stream_json: 'stream-json',
  json: 'json',
  text: 'text',
  none: '无流式',
  unknown: '流式未知',
};

const ENGINE_TRANSCRIPT_MODE_LABEL: Record<NonNullable<AgentEngineDescriptor['reliability']>['transcriptMode'], string> = {
  clean_stream_json: '干净 transcript',
  raw_terminal: '原始终端 transcript',
  session_import: '历史导入 transcript',
  unknown: 'transcript 未知',
};

const ENGINE_TOOL_SUPPORT_LABEL: Record<NonNullable<AgentEngineDescriptor['reliability']>['toolSupport'], string> = {
  none: '无工具',
  read_only_cli_tools: '只读工具',
  workspace_tools: '工作区工具',
  mcp_bridge: 'MCP bridge',
  unknown: '工具未知',
};

const ENGINE_FAILURE_LABEL: Record<AgentEngineFailureDiagnostics['category'], string> = {
  auth: '认证失败',
  quota: '额度受限',
  timeout: '运行超时',
  network: '网络异常',
  permission: '权限不足',
  missing_cli: 'CLI 不可用',
  runtime: '运行失败',
  unknown: '运行失败',
};

function formatEngineFailureAge(occurredAt?: number, now = Date.now()): string | null {
  if (typeof occurredAt !== 'number' || !Number.isFinite(occurredAt)) return null;
  const ageMs = Math.max(0, now - occurredAt);
  if (ageMs < 60_000) return '刚刚失败';
  if (ageMs < 60 * 60_000) return `${Math.floor(ageMs / 60_000)} 分钟前失败`;
  if (ageMs < 24 * 60 * 60_000) return `${Math.floor(ageMs / (60 * 60_000))} 小时前失败`;
  return `${Math.floor(ageMs / (24 * 60 * 60_000))} 天前失败`;
}

export interface EffortOption {
  value: EffortLevel;
  label: string;
  shortLabel: string;
  color: string;
  tint: string;
}

const EFFORT_OPTION_CONFIG: Record<EffortLevel, EffortOption> = {
  low: {
    value: 'low',
    label: 'Low',
    shortLabel: '低',
    color: 'text-zinc-400',
    tint: 'bg-zinc-700',
  },
  medium: {
    value: 'medium',
    label: 'Med',
    shortLabel: '中',
    color: 'text-blue-400',
    tint: 'bg-blue-500/15',
  },
  high: {
    value: 'high',
    label: 'High',
    shortLabel: '高',
    color: 'text-amber-400',
    tint: 'bg-amber-500/15',
  },
  xhigh: {
    value: 'xhigh',
    label: 'XHigh',
    shortLabel: '极高',
    color: 'text-orange-300',
    tint: 'bg-orange-500/15',
  },
  max: {
    value: 'max',
    label: 'Max',
    shortLabel: 'Max',
    color: 'text-rose-300',
    tint: 'bg-rose-500/15',
  },
  ultra_code: {
    value: 'ultra_code',
    label: 'Ultra Code',
    shortLabel: 'Ultra',
    color: 'text-emerald-300',
    tint: 'bg-emerald-500/15',
  },
};

const BASE_EFFORT_OPTIONS = [
  EFFORT_OPTION_CONFIG.low,
  EFFORT_OPTION_CONFIG.medium,
  EFFORT_OPTION_CONFIG.high,
];

const EXTENDED_EFFORT_OPTIONS = [
  ...BASE_EFFORT_OPTIONS,
  EFFORT_OPTION_CONFIG.xhigh,
  EFFORT_OPTION_CONFIG.max,
];

const CODE_EFFORT_OPTIONS = [
  ...BASE_EFFORT_OPTIONS,
  EFFORT_OPTION_CONFIG.xhigh,
  EFFORT_OPTION_CONFIG.ultra_code,
];

const SINGLE_EFFORT_OPTION: EffortOption[] = [
  {
    ...EFFORT_OPTION_CONFIG.low,
    label: 'Default',
    shortLabel: 'Default',
  },
];

const PROVIDER_LOGO_BADGE_CLASSNAME = 'bg-zinc-100 text-zinc-950 border border-zinc-300';

export const CAPABILITY_CONFIG: Record<string, { icon: React.ReactNode; color: string }> = {
  code: {
    icon: <Code2 className="w-2.5 h-2.5" />,
    color: 'bg-emerald-500/20 text-emerald-300',
  },
  vision: {
    icon: <Eye className="w-2.5 h-2.5" />,
    color: 'bg-purple-500/20 text-purple-300',
  },
  tool: {
    icon: <Wrench className="w-2.5 h-2.5" />,
    color: 'bg-blue-500/20 text-blue-300',
  },
  reasoning: {
    icon: <Brain className="w-2.5 h-2.5" />,
    color: 'bg-amber-500/20 text-amber-300',
  },
  fast: {
    icon: <Gauge className="w-2.5 h-2.5" />,
    color: 'bg-sky-500/20 text-sky-300',
  },
  longContext: {
    icon: <span className="text-[9px] font-semibold">LC</span>,
    color: 'bg-teal-500/20 text-teal-300',
  },
};

export const HEALTH_DOT_COLOR: Record<string, string> = {
  healthy: 'bg-green-400',
  degraded: 'bg-yellow-400',
  unavailable: 'bg-red-400',
  recovering: 'bg-blue-400',
};

export interface ProviderHealthSnapshot {
  status?: string;
  latencyP50?: number;
  errorRate?: number;
}

export type ProviderAvailabilityState = 'healthy' | 'recovering' | 'unknown' | 'degraded' | 'unavailable';

export interface ProviderHealthSummary {
  state: ProviderAvailabilityState;
  label: string;
  detail: string;
  rank: number;
  dotClass: string;
  badgeClass: string;
}

export interface ProviderBillingSummary {
  mode: BillingMode;
  label: string;
  detail: string;
  badgeClass: string;
}

const PROVIDER_HEALTH_RANK: Record<ProviderAvailabilityState, number> = {
  healthy: 0,
  recovering: 1,
  unknown: 2,
  degraded: 3,
  unavailable: 4,
};

const PROVIDER_HEALTH_LABEL: Record<ProviderAvailabilityState, string> = {
  healthy: '健康',
  recovering: '恢复中',
  unknown: '未检测',
  degraded: '降级',
  unavailable: '不可用',
};

const PROVIDER_HEALTH_BADGE_CLASS: Record<ProviderAvailabilityState, string> = {
  healthy: 'border-emerald-500/20 bg-emerald-500/10 text-emerald-300',
  recovering: 'border-sky-500/20 bg-sky-500/10 text-sky-300',
  unknown: 'border-zinc-700 bg-zinc-900 text-zinc-500',
  degraded: 'border-amber-500/20 bg-amber-500/10 text-amber-300',
  unavailable: 'border-red-500/20 bg-red-500/10 text-red-300',
};

const PROVIDER_BILLING_LABEL: Record<BillingMode, string> = {
  free: '免费',
  plan: '套餐',
  payg: '按量',
  unknown: '计费未知',
};

const PROVIDER_BILLING_DETAIL: Record<BillingMode, string> = {
  free: '免费额度：成本压力低，自动策略主要按能力和速度选择。',
  plan: '套餐/订阅：切换快模型通常不省钱，自动策略主要按速度和能力选择。',
  payg: '按量付费：简单任务可由自动策略切到快模型降低成本和延迟。',
  unknown: '计费未知：自动策略会保守处理，不把省钱作为切换依据。',
};

const PROVIDER_BILLING_BADGE_CLASS: Record<BillingMode, string> = {
  free: 'border-emerald-500/20 bg-emerald-500/10 text-emerald-300',
  plan: 'border-sky-500/20 bg-sky-500/10 text-sky-300',
  payg: 'border-amber-500/20 bg-amber-500/10 text-amber-300',
  unknown: 'border-zinc-700 bg-zinc-900 text-zinc-500',
};

function normalizeProviderAvailabilityState(status?: string): ProviderAvailabilityState {
  switch (status) {
    case 'healthy':
    case 'recovering':
    case 'degraded':
    case 'unavailable':
      return status;
    default:
      return 'unknown';
  }
}

export function buildProviderHealthSummary(health?: ProviderHealthSnapshot | null): ProviderHealthSummary {
  const state = normalizeProviderAvailabilityState(health?.status);
  const label = state === 'unknown' && health?.status ? '未知' : PROVIDER_HEALTH_LABEL[state];
  const latencyLine = typeof health?.latencyP50 === 'number' && Number.isFinite(health.latencyP50)
    ? `P50 ${Math.round(health.latencyP50)}ms`
    : null;
  const errorLine = typeof health?.errorRate === 'number' && Number.isFinite(health.errorRate)
    ? `错误率 ${Math.round(health.errorRate * 100)}%`
    : null;
  const detail = [latencyLine, errorLine].filter(Boolean).join(' · ')
    || (health ? `Provider 状态: ${health.status || 'unknown'}` : '最近健康状态未上报');

  return {
    state,
    label,
    detail,
    rank: PROVIDER_HEALTH_RANK[state],
    dotClass: HEALTH_DOT_COLOR[state] ?? 'bg-gray-400',
    badgeClass: PROVIDER_HEALTH_BADGE_CLASS[state],
  };
}

export function compareProviderHealth(
  left?: ProviderHealthSnapshot | null,
  right?: ProviderHealthSnapshot | null,
): number {
  return buildProviderHealthSummary(left).rank - buildProviderHealthSummary(right).rank;
}

export function sortProviderGroupsByModelStrategy<T extends RuntimeModelOptionGroup>(
  groups: readonly T[],
  healthMap: Record<string, ProviderHealthSnapshot | undefined>,
): T[] {
  return [...groups].sort((left, right) => {
    const favoriteOrder = Number(right.providerFavorite === true) - Number(left.providerFavorite === true);
    if (favoriteOrder !== 0) return favoriteOrder;

    const leftProvider = left.options[0]?.provider ?? left.provider;
    const rightProvider = right.options[0]?.provider ?? right.provider;
    return compareProviderHealth(healthMap[leftProvider], healthMap[rightProvider]);
  });
}

export function buildProviderBillingSummary(mode?: BillingMode | null): ProviderBillingSummary {
  const billingMode = mode ?? 'unknown';
  return {
    mode: billingMode,
    label: PROVIDER_BILLING_LABEL[billingMode],
    detail: PROVIDER_BILLING_DETAIL[billingMode],
    badgeClass: PROVIDER_BILLING_BADGE_CLASS[billingMode],
  };
}

export function ProviderBillingBadge({ summary }: { summary: ProviderBillingSummary }) {
  return (
    <span
      className={`inline-flex items-center rounded border px-1.5 py-0.5 ${summary.badgeClass}`}
      title={summary.detail}
      data-provider-billing-mode={summary.mode}
    >
      {summary.label}
    </span>
  );
}

// ============================================================================
// 引擎级计费模式 + 模型兼容原因 — 文案全部经 i18n 由枚举/reasonCode 派生
// （矩阵数据来自 @shared/constants/engineCompat，本层只负责把它翻译成可见标签）
// ============================================================================

const ENGINE_BILLING_BADGE_CLASS: Record<EngineBillingMode, string> = {
  subscription: 'border-sky-500/20 bg-sky-500/10 text-sky-300',
  api_key_payg: 'border-amber-500/20 bg-amber-500/10 text-amber-300',
  free_tier: 'border-emerald-500/20 bg-emerald-500/10 text-emerald-300',
  unknown: 'border-zinc-700 bg-zinc-900 text-zinc-500',
};

export interface EngineBillingSummary {
  mode: EngineBillingMode;
  label: string;
  detail: string;
  badgeClass: string;
}

/** 把引擎 kind 翻成"订阅/按量/免费/未知"计费摘要（标签+hover 详情走 i18n）。 */
export function buildEngineBillingSummary(kind: AgentEngineKind, t: Translations): EngineBillingSummary {
  const mode = getEngineBillingMode(kind);
  const copy = t.engineCompat.billing[mode];
  return {
    mode,
    label: copy.label,
    detail: copy.detail,
    badgeClass: ENGINE_BILLING_BADGE_CLASS[mode],
  };
}

/** 把模型兼容 reasonCode 翻成可见原因文案（不可用 / 注解共用，纯 i18n 查表）。 */
export function resolveEngineModelCompatReason(
  reasonCode: EngineModelCompatReasonCode,
  t: Translations,
): string {
  return t.engineCompat.reason[reasonCode];
}

/**
 * 从签名目录模型列表构造兼容判定上下文：拆出"已启用 / 已停用"模型 id 集合，
 * 喂给 getEngineModelCompat（codex/claude 用）。mimo/kimi 无目录走直传，传空即可。
 */
export function buildEngineModelCompatContext(
  models?: readonly { id: string; disabledReason?: string }[] | null,
): EngineModelCompatContext {
  if (!models || models.length === 0) return {};
  const enabled = new Set<string>();
  const disabled = new Set<string>();
  for (const model of models) {
    (model.disabledReason ? disabled : enabled).add(model.id);
  }
  return { signedCatalogEnabledModelIds: enabled, signedCatalogDisabledModelIds: disabled };
}

/**
 * 单个引擎模型的兼容注解文案：disabledReason 是签名目录里更细的原文，优先展示；
 * 否则回落到 getEngineModelCompat 的 reasonCode 经 i18n 派生（mimo/kimi 的"由 CLI 解析"等）。
 */
export function getEngineModelCompatReasonText(
  kind: AgentEngineKind,
  model: { id: string; disabledReason?: string },
  context: EngineModelCompatContext,
  t: Translations,
): string | null {
  if (model.disabledReason) return model.disabledReason;
  const compat = getEngineModelCompat(kind, model.id, context);
  return compat.reasonCode ? resolveEngineModelCompatReason(compat.reasonCode, t) : null;
}

const ENGINE_RELIABILITY_TONE_CLASS: Record<string, string> = {
  ready: 'border-emerald-500/20 bg-emerald-500/[0.08] text-emerald-200',
  warning: 'border-amber-500/20 bg-amber-500/[0.08] text-amber-200',
  error: 'border-red-500/20 bg-red-500/[0.08] text-red-200',
  info: 'border-sky-500/20 bg-sky-500/[0.08] text-sky-200',
};

const ENGINE_RELIABILITY_DOT_CLASS: Record<string, string> = {
  ready: 'bg-emerald-300',
  warning: 'bg-amber-300',
  error: 'bg-red-300',
  info: 'bg-sky-300',
};

/** 外部引擎可靠性摘要面板（tone 着色 + 摘要 + 能力/详情行）。 */
export function EngineReliabilityPanel({ summary }: { summary: EngineReliabilitySummary }) {
  const toneClass = ENGINE_RELIABILITY_TONE_CLASS[summary.tone] ?? ENGINE_RELIABILITY_TONE_CLASS.info;
  const dotClass = ENGINE_RELIABILITY_DOT_CLASS[summary.tone] ?? ENGINE_RELIABILITY_DOT_CLASS.info;
  const secondaryLine = summary.capabilityLine || summary.detail;
  return (
    <div className="border-b border-zinc-700/50 px-2 py-1.5">
      <div
        className={`rounded-md border px-2 py-1.5 text-[11px] leading-relaxed ${toneClass}`}
        data-testid="engine-reliability-summary"
      >
        <div className="flex min-w-0 items-center gap-1.5">
          <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${dotClass}`} />
          <span className="shrink-0 font-medium">{summary.label}</span>
          <span className="min-w-0 truncate text-zinc-200/90" title={summary.summary}>
            {summary.summary}
          </span>
        </div>
        {secondaryLine && (
          <div className="mt-0.5 truncate text-[10px] text-zinc-300/70" title={secondaryLine}>
            {secondaryLine}
          </div>
        )}
      </div>
    </div>
  );
}

export function EngineBillingBadge({ summary }: { summary: EngineBillingSummary }) {
  return (
    <span
      className={`inline-flex items-center rounded border px-1.5 py-0.5 ${summary.badgeClass}`}
      title={summary.detail}
      data-engine-billing-mode={summary.mode}
    >
      {summary.label}
    </span>
  );
}

export function ProviderHealthBadge({ summary }: { summary: ProviderHealthSummary }) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 ${summary.badgeClass}`}
      title={summary.detail}
      aria-label={`Provider 状态: ${summary.label}`}
      data-provider-health-state={summary.state}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${summary.dotClass}`} />
      {summary.label}
    </span>
  );
}

export function ProviderSourceBadge({ sourceLabel }: { sourceLabel?: string }) {
  if (!sourceLabel) return null;
  return (
    <span
      className="text-[10px] font-medium text-zinc-500"
      title={`来源: ${sourceLabel}`}
      data-provider-source-label={sourceLabel}
    >
      来源 {sourceLabel}
    </span>
  );
}

function formatProviderEndpointDisplay(endpoint: string): string {
  try {
    const url = new URL(endpoint);
    const path = url.pathname === '/' ? '' : url.pathname.replace(/\/$/, '');
    return `${url.host}${path}`;
  } catch {
    return endpoint;
  }
}

export function ProviderTransportBadge({
  protocol,
  transportLabel,
  endpoint,
}: {
  protocol?: ModelProviderProtocol;
  transportLabel?: string;
  endpoint?: string;
}) {
  const label = transportLabel || (protocol === 'claude' ? 'Claude-compatible' : protocol === 'openai' ? 'OpenAI-compatible' : undefined);
  if (!label && !endpoint) return null;

  const endpointDisplay = endpoint ? formatProviderEndpointDisplay(endpoint) : undefined;
  const title = [
    label ? `协议: ${label}` : null,
    endpoint ? `Endpoint: ${endpoint}` : null,
  ].filter(Boolean).join(' · ');

  return (
    <span
      className="max-w-[11rem] truncate text-[10px] font-medium text-zinc-400"
      title={title}
      data-provider-transport-protocol={protocol}
      data-provider-endpoint={endpoint}
    >
      {[label, endpointDisplay].filter(Boolean).join(' · ')}
    </span>
  );
}

/**
 * 把 provider 的检测状态/计费/来源/协议/endpoint 汇总成一段多行 tooltip 文本。
 * C-7：模型菜单 provider 头不再平铺这些工程内幕 badge，收进 hover 详情。
 */
export function buildProviderMetaTitle(group: {
  healthSummary: ProviderHealthSummary;
  billingSummary: ProviderBillingSummary;
  providerSourceLabel?: string;
  providerProtocol?: ModelProviderProtocol;
  providerTransportLabel?: string;
  providerEndpoint?: string;
}): string {
  const protocolLabel = group.providerTransportLabel
    || (group.providerProtocol === 'claude' ? 'Claude-compatible'
      : group.providerProtocol === 'openai' ? 'OpenAI-compatible' : undefined);
  return [
    `状态: ${group.healthSummary.label} · ${group.healthSummary.detail}`,
    `计费: ${group.billingSummary.label} · ${group.billingSummary.detail}`,
    group.providerSourceLabel ? `来源: ${group.providerSourceLabel}` : null,
    protocolLabel ? `协议: ${protocolLabel}` : null,
    group.providerEndpoint ? `Endpoint: ${group.providerEndpoint}` : null,
  ].filter(Boolean).join('\n');
}

export function formatNativeModelSwitcherTooltip(args: {
  engineLabel: string;
  currentModel: string;
  displayProvider: ModelProvider;
  displayModel: string;
  adaptive: boolean;
  overridden: boolean;
  billingSummary?: ProviderBillingSummary | null;
  healthSummary?: ProviderHealthSummary | null;
  effort?: Pick<EffortOption, 'label'> | null;
  thinkingLabel?: string | null;
}): string {
  const modelLine = args.adaptive
    ? `自动路由（按任务、成本和能力切换，当前主任务 ${args.currentModel}）`
    : args.overridden
      ? `已覆盖: ${args.displayProvider}/${args.displayModel} (原主任务: ${args.currentModel})`
      : `主任务模型: ${args.displayProvider}/${args.displayModel}`;
  return [
    modelLine,
    `Engine: ${args.engineLabel}`,
    args.billingSummary ? `计费: ${args.billingSummary.label}` : null,
    args.healthSummary ? `Provider: ${args.healthSummary.label}` : null,
    args.effort ? `Effort: ${args.effort.label}` : null,
    args.thinkingLabel ? `Thinking: ${args.thinkingLabel}` : null,
  ].filter(Boolean).join(' · ');
}

export function formatExternalModelSwitcherTooltip(args: {
  engineLabel: string;
  model: string;
  effort?: Pick<EffortOption, 'label'> | null;
  reliabilityLabel?: string | null;
}): string {
  return [
    `Engine: ${args.engineLabel}`,
    `主任务模型: ${args.model}`,
    args.effort ? `Effort: ${args.effort.label}` : null,
    args.reliabilityLabel ? `状态: ${args.reliabilityLabel}` : null,
  ].filter(Boolean).join(' · ');
}

export function formatEngineCwdPolicy(descriptor: AgentEngineDescriptor): string {
  return descriptor.cwdPolicy === 'workspace_only' ? '当前工作目录' : descriptor.cwdPolicy;
}

export function getEngineUnavailableReason(
  descriptor: AgentEngineDescriptor,
  needsWorkspace: boolean,
): string | null {
  if (needsWorkspace) return '需要先选择工作目录';
  if (!descriptor.executable) return descriptor.lastError || 'CLI 不可执行';
  if (descriptor.installState === 'missing') return descriptor.lastError || '未安装';
  if (descriptor.runtimeState === 'error' || descriptor.runtimeState === 'blocked') {
    return descriptor.lastError || ENGINE_RUNTIME_LABEL[descriptor.runtimeState];
  }
  return null;
}

export function formatEngineTooltip(descriptor: AgentEngineDescriptor, needsWorkspace: boolean): string {
  const unavailableReason = getEngineUnavailableReason(descriptor, needsWorkspace);
  const reliabilityLine = formatEngineReliabilityContract(descriptor);
  return [
    descriptor.label,
    descriptor.kind === 'native' ? 'Native · 内置 runtime' : '外部 CLI',
    `${ENGINE_INSTALL_LABEL[descriptor.installState]} / ${ENGINE_RUNTIME_LABEL[descriptor.runtimeState]}`,
    unavailableReason,
    reliabilityLine,
    descriptor.version,
    ENGINE_PERMISSION_LABEL[descriptor.defaultPermissionProfile],
    formatEngineCwdPolicy(descriptor),
    ENGINE_RISK_LABEL[descriptor.riskTier],
    descriptor.command,
    descriptor.lastError,
  ].filter(Boolean).join(' · ');
}

export type EngineReliabilityTone = 'ready' | 'warning' | 'error' | 'info';

export interface EngineReliabilitySummary {
  tone: EngineReliabilityTone;
  label: string;
  summary: string;
  detail?: string;
  capabilityLine?: string;
}

export function formatEngineReliabilityContract(descriptor: AgentEngineDescriptor): string | null {
  const reliability = descriptor.reliability;
  if (!reliability) return null;
  const parts = [
    ENGINE_CLI_STATUS_LABEL[reliability.cliStatus],
    ENGINE_AUTH_STATE_LABEL[reliability.authState],
    ENGINE_QUOTA_STATE_LABEL[reliability.quotaState],
    ENGINE_STREAMING_MODE_LABEL[reliability.streamingMode],
    reliability.partialMessages ? 'partial messages' : null,
    ENGINE_TRANSCRIPT_MODE_LABEL[reliability.transcriptMode],
    ENGINE_TOOL_SUPPORT_LABEL[reliability.toolSupport],
    reliability.mcpBridge ? 'MCP bridge' : null,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(' · ') : null;
}

export function buildEngineReliabilitySummary(args: {
  descriptor: AgentEngineDescriptor | null;
  needsWorkspace: boolean;
  selectedModel?: AgentEngineModelCatalogModel | null;
  sessionFailure?: AgentEngineFailureDiagnostics | null;
  now?: number;
}): EngineReliabilitySummary | null {
  const { descriptor, needsWorkspace, selectedModel, sessionFailure, now } = args;
  if (!descriptor || descriptor.kind === 'native') return null;

  if (sessionFailure) {
    const reliabilityLine = descriptor.reliability
      ? formatEngineReliabilityContract({
        ...descriptor,
        reliability: {
          ...descriptor.reliability,
          ...sessionFailure.reliability,
        },
      })
      : null;
    return {
      tone: sessionFailure.retryable || sessionFailure.category === 'timeout' || sessionFailure.category === 'network'
        ? 'warning'
        : 'error',
      label: ENGINE_FAILURE_LABEL[sessionFailure.category],
      summary: sessionFailure.suggestion,
      detail: [
        sessionFailure.reason,
        formatEngineFailureAge(sessionFailure.occurredAt, now),
        typeof sessionFailure.statusCode === 'number' ? `HTTP ${sessionFailure.statusCode}` : null,
        typeof sessionFailure.exitCode === 'number' ? `exit ${sessionFailure.exitCode}` : null,
        sessionFailure.retryable ? '可重试' : '需处理',
      ].filter(Boolean).join(' · '),
      ...(reliabilityLine ? { capabilityLine: reliabilityLine } : {}),
    };
  }

  const unavailableReason = getEngineUnavailableReason(descriptor, needsWorkspace);
  if (unavailableReason) {
    const tone: EngineReliabilityTone =
      descriptor.installState === 'missing' || descriptor.runtimeState === 'error' || descriptor.runtimeState === 'blocked'
        ? 'error'
        : 'warning';
    return {
      tone,
      label: tone === 'error' ? '不可用' : '需要处理',
      summary: unavailableReason,
      detail: '这条外部引擎链路会影响订阅模型的输出可靠性。',
    };
  }

  if (descriptor.runtimeState === 'not_configured') {
    return {
      tone: 'warning',
      label: '需要配置',
      summary: `${descriptor.label} 已检测到，但还需要完成登录或默认配置。`,
      detail: descriptor.lastError,
    };
  }

  if (selectedModel?.disabledReason) {
    return {
      tone: 'warning',
      label: '模型受限',
      summary: selectedModel.disabledReason,
      detail: '请选择可用模型，避免这一轮落到不可用订阅模型。',
    };
  }

  if (descriptor.runtimeState === 'unknown') {
    return {
      tone: 'info',
      label: '待确认',
      summary: `${descriptor.label} 已列出，但运行状态还没有确认。`,
      detail: descriptor.lastError,
    };
  }

  const streamLine = descriptor.capabilities.includes('stream_events')
    ? '支持流式事件'
    : '仅确认任务完成状态';
  const executionLine = descriptor.capabilities.includes('execute')
    ? 'CLI 执行能力可用'
    : 'CLI 执行能力受限';
  const modelLine = selectedModel?.capabilities.includes('code')
    ? '模型目录标记适合代码任务'
    : '模型目录未标记代码任务能力';
  const modelMatchesAgentTasks = selectedModel?.capabilities.includes('code') ?? false;
  const reliabilityLine = formatEngineReliabilityContract(descriptor);

  return {
    tone: descriptor.capabilities.includes('execute') && modelMatchesAgentTasks ? 'ready' : 'info',
    label: '可用',
    summary: `${descriptor.label} 可用，当前模型 ${selectedModel?.label ?? selectedModel?.id ?? '使用默认选择'}。`,
    capabilityLine: [streamLine, executionLine, modelLine, reliabilityLine].filter(Boolean).join(' · '),
  };
}

export function isExternalEngineKind(kind: AgentEngineKind): kind is ExternalAgentEngineKind {
  // 判据与 ExternalAgentEngineKind = Exclude<AgentEngineKind, 'native'> 的类型定义一致：
  // 所有非 native 引擎都是外部 CLI（renderer 不依赖 main 侧 agentEngineGuards，只共享这条 kind !== 'native' 判据）。
  // 旧实现只判 codex/claude，导致 mimo/kimi 在模型切换器里被当 native 处理（列不出 catalog 模型）。
  return kind !== 'native';
}

export function buildModelSwitcherEngineSelection(
  descriptor: AgentEngineDescriptor,
  workingDirectory?: string | null,
  model?: string | null,
): Partial<AgentEngineSessionMetadata> {
  const selection: Partial<AgentEngineSessionMetadata> = {
    kind: descriptor.kind,
    permissionProfile: descriptor.defaultPermissionProfile,
    origin: 'manual',
  };
  if (descriptor.kind !== 'native' && workingDirectory) {
    selection.cwd = workingDirectory;
  }
  if (descriptor.kind !== 'native' && model) {
    selection.model = model;
  }
  return selection;
}

export function ProviderLogo({ provider, label, icon }: { provider: ModelProvider; label: string; icon?: string }) {
  const imageSource = useProviderIconImageSource(icon);
  if (icon) {
    if (isProviderImageIcon(icon)) {
      return (
        <span
          aria-hidden="true"
          className={`inline-flex h-3.5 w-3.5 items-center justify-center overflow-hidden rounded-[3px] ${PROVIDER_LOGO_BADGE_CLASSNAME}`}
        >
          {imageSource ? (
            <img src={imageSource} alt="" className="h-full w-full object-cover" />
          ) : (
            <span className="text-[7px] font-bold leading-none">{label.slice(0, 1).toUpperCase()}</span>
          )}
        </span>
      );
    }
    return (
      <span
        aria-hidden="true"
        className={`inline-flex h-3.5 min-w-3.5 items-center justify-center rounded-[3px] px-[2px] text-[7px] font-bold leading-none ${PROVIDER_LOGO_BADGE_CLASSNAME}`}
      >
        {icon}
      </span>
    );
  }

  const mark = getProviderLogoMark(provider);
  if (mark) {
    const paths = mark.paths ?? (mark.path ? [mark.path] : []);
    return (
      <span
        aria-hidden="true"
        className={`inline-flex h-3.5 w-3.5 items-center justify-center rounded-[3px] ${PROVIDER_LOGO_BADGE_CLASSNAME}`}
      >
        <svg
          viewBox="0 0 24 24"
          className="h-2.5 w-2.5 fill-current"
          role="img"
        >
          <title>{mark.title}</title>
          {paths.map((path) => (
            <path key={path} d={path} />
          ))}
        </svg>
      </span>
    );
  }

  const badge = getProviderLogoBadge(provider);
  const badgeLabel = badge?.label ?? (label.trim()[0] || provider[0] || '?').toUpperCase();

  return (
    <span
      aria-hidden="true"
      className={`inline-flex h-3.5 min-w-3.5 items-center justify-center rounded-[3px] px-[2px] text-[7px] font-bold leading-none ${PROVIDER_LOGO_BADGE_CLASSNAME}`}
    >
      {badgeLabel}
    </span>
  );
}

export function getProviderEffortOptions(
  provider: ModelProvider,
  model: string,
  features: readonly RuntimeModelFeature[] = [],
): EffortOption[] {
  if (provider === 'xiaomi') return BASE_EFFORT_OPTIONS;
  if (provider === 'claude') return EXTENDED_EFFORT_OPTIONS;
  if (provider === 'openai' && /codex|code/i.test(model)) return CODE_EFFORT_OPTIONS;
  if (provider === 'openai') return BASE_EFFORT_OPTIONS;
  if (provider === 'grok' || provider === 'perplexity') {
    return features.includes('reasoning') ? BASE_EFFORT_OPTIONS : SINGLE_EFFORT_OPTION;
  }
  return features.includes('reasoning') || /reason|thinking|think|r1|o\d/i.test(model)
    ? BASE_EFFORT_OPTIONS
    : SINGLE_EFFORT_OPTION;
}

export function getEngineEffortOptions(kind: AgentEngineKind): EffortOption[] {
  if (kind === 'codex_cli') return CODE_EFFORT_OPTIONS;
  if (kind === 'claude_code') return EXTENDED_EFFORT_OPTIONS;
  return BASE_EFFORT_OPTIONS;
}

export function getSelectedEffortOption(
  effortLevel: EffortLevel,
  options: readonly EffortOption[],
): EffortOption {
  return options.find((option) => option.value === effortLevel)
    ?? options.find((option) => option.value === 'high')
    ?? options[options.length - 1]
    ?? EFFORT_OPTION_CONFIG.high;
}
