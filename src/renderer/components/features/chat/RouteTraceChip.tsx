import React, { useState } from 'react';
import { AlertTriangle, ChevronDown, ChevronRight, GitBranch } from 'lucide-react';
import type {
  BillingMode,
  ModelCapabilityNeed,
  ModelCostPolicy,
  ModelDecisionEventData,
  ModelDecisionReason,
  ModelExternalEngineSnapshot,
  ModelProviderHealthStatus,
  ModelSpeedPolicy,
  ModelTaskClass,
  ModelToolPolicy,
} from '@shared/contract';

const REASON_LABELS: Record<ModelDecisionReason, string> = {
  'user-selected': '用户选择',
  'role-tier': '角色档位',
  'simple-task-free': '简单任务',
  'billing-gate-skip': '计费跳过',
  'strategy-fast': '快速策略',
  'strategy-main': '主任务策略',
  'strategy-deep': '深度策略',
  'strategy-vision': '视觉策略',
  'capability-vision': '视觉能力',
  'fallback-availability': '可用性降级',
};

const TASK_LABELS: Record<ModelTaskClass, string> = {
  simple: '简单快答',
  coding: '代码任务',
  vision: '视觉任务',
  search: '检索任务',
  artifact: '产物生成',
  'long-context': '长上下文',
  'multi-tool': '多工具',
  unknown: '未识别',
};

const COST_LABELS: Record<ModelCostPolicy, string> = {
  'save-cost': '按量省成本',
  'plan-no-savings': '套餐内不切换',
  'unknown-conservative': '计费未知保守',
  'user-locked': '用户锁定',
  neutral: '常规',
};

const BILLING_LABELS: Record<BillingMode, string> = {
  free: '免费额度',
  plan: '套餐/订阅',
  payg: '按量付费',
  unknown: '未知计费',
};

const SPEED_LABELS: Record<ModelSpeedPolicy, string> = {
  'fast-path': '快模型优先',
  normal: '常规',
  'provider-degraded': 'provider 状态风险',
  'fallback-recovery': 'fallback 恢复',
};

const TOOL_LABELS: Record<ModelToolPolicy, string> = {
  'runtime-checked': '执行前复核',
  'disabled-by-model': '模型不支持',
  unknown: '未知',
};

const CAPABILITY_LABELS: Record<ModelCapabilityNeed, string> = {
  vision: '视觉',
  code: '代码',
  search: '检索',
  artifact: '产物',
  'long-context': '长上下文',
  'tool-use': '工具',
};

const HEALTH_LABELS: Record<ModelProviderHealthStatus, string> = {
  healthy: '健康',
  degraded: '不稳定',
  unavailable: '不可用',
  recovering: '恢复中',
  unknown: '暂无样本',
};

const ENGINE_KIND_LABELS: Record<ModelExternalEngineSnapshot['kind'], string> = {
  codex_cli: 'Codex CLI',
  claude_code: 'Claude Code',
};

const ENGINE_INSTALL_LABELS: Record<ModelExternalEngineSnapshot['installState'], string> = {
  builtin: '内置',
  installed: '已安装',
  missing: '缺失',
};

const ENGINE_RUNTIME_LABELS: Record<ModelExternalEngineSnapshot['runtimeState'], string> = {
  ready: '可用',
  not_configured: '需配置',
  blocked: '阻断',
  error: '异常',
  unknown: '未知',
};

const ENGINE_CLI_LABELS: Record<NonNullable<ModelExternalEngineSnapshot['reliability']>['cliStatus'], string> = {
  available: 'CLI 可用',
  missing: 'CLI 缺失',
  error: 'CLI 异常',
  not_checked: 'CLI 未检测',
};

const ENGINE_AUTH_LABELS: Record<NonNullable<ModelExternalEngineSnapshot['reliability']>['authState'], string> = {
  authenticated: '已登录',
  needs_login: '需登录',
  not_checked: '登录未检测',
  unknown: '登录未知',
};

const ENGINE_QUOTA_LABELS: Record<NonNullable<ModelExternalEngineSnapshot['reliability']>['quotaState'], string> = {
  available: 'quota 可用',
  limited: 'quota 受限',
  exhausted: 'quota 耗尽',
  not_checked: 'quota 未检测',
  unknown: 'quota 未知',
};

const ENGINE_STREAM_LABELS: Record<NonNullable<ModelExternalEngineSnapshot['reliability']>['streamingMode'], string> = {
  stream_json: 'stream-json',
  json: 'json',
  text: 'text',
  none: '无流式',
  unknown: '流式未知',
};

const ENGINE_TOOL_LABELS: Record<NonNullable<ModelExternalEngineSnapshot['reliability']>['toolSupport'], string> = {
  none: '无工具',
  read_only_cli_tools: '只读 CLI 工具',
  workspace_tools: '工作区工具',
  mcp_bridge: 'MCP bridge',
  unknown: '工具未知',
};

const ENGINE_TRANSCRIPT_LABELS: Record<NonNullable<ModelExternalEngineSnapshot['reliability']>['transcriptMode'], string> = {
  clean_stream_json: '干净 stream-json transcript',
  raw_terminal: '原始终端 transcript',
  session_import: '历史导入 transcript',
  unknown: 'transcript 未知',
};

function getToneClass(reason: ModelDecisionReason): string {
  // 收敛为两档：正常路由一律中性灰，仅降级/兜底用单一警示色，
  // 避免一个 chip 覆盖 6 种饱和色和正文/diff 抢注意力。
  if (reason === 'fallback-availability') {
    return 'border-amber-500/25 bg-amber-500/[0.08] text-amber-200';
  }
  return 'border-white/[0.08] bg-white/[0.03] text-zinc-400';
}

function formatModel(provider: string, model: string): string {
  return `${provider}/${model}`;
}

function formatComplexityScore(score?: number): string | null {
  if (score === undefined) return null;
  return `${score.toFixed(2)} · 规则估计，用于本轮路由解释，不代表模型质量评分`;
}

function formatSampleAge(sampledAt: number, now = Date.now()): string {
  const ageMs = Math.max(0, now - sampledAt);
  if (ageMs < 60_000) return '刚刚采样';
  if (ageMs < 60 * 60_000) return `采样 ${Math.floor(ageMs / 60_000)} 分钟前`;
  if (ageMs < 24 * 60 * 60_000) return `采样 ${Math.floor(ageMs / (60 * 60_000))} 小时前`;
  return `采样 ${Math.floor(ageMs / (24 * 60 * 60_000))} 天前`;
}

function formatFailureAge(occurredAt?: number, now = Date.now()): string | null {
  if (typeof occurredAt !== 'number' || !Number.isFinite(occurredAt)) return null;
  const ageMs = Math.max(0, now - occurredAt);
  if (ageMs < 60_000) return '刚刚失败';
  if (ageMs < 60 * 60_000) return `${Math.floor(ageMs / 60_000)} 分钟前失败`;
  if (ageMs < 24 * 60 * 60_000) return `${Math.floor(ageMs / (60 * 60_000))} 小时前失败`;
  return `${Math.floor(ageMs / (24 * 60 * 60_000))} 天前失败`;
}

function formatProviderHealth(decision: ModelDecisionEventData): string | null {
  const snapshot = decision.providerHealthSnapshot;
  if (!snapshot) return null;
  if (snapshot.status === 'unknown') {
    return `${snapshot.provider} · 最近窗口 ${HEALTH_LABELS.unknown} · ${formatSampleAge(snapshot.sampledAt)} · 非实时 SLA`;
  }
  const parts = [
    `${snapshot.provider} · 最近窗口 ${HEALTH_LABELS[snapshot.status]}`,
    formatSampleAge(snapshot.sampledAt),
    snapshot.latencyP50 !== undefined ? `p50 ${snapshot.latencyP50}ms` : null,
    snapshot.latencyP95 !== undefined ? `p95 ${snapshot.latencyP95}ms` : null,
    snapshot.errorRate !== undefined ? `err ${(snapshot.errorRate * 100).toFixed(0)}%` : null,
    '非实时 SLA',
  ].filter(Boolean);
  return parts.join(' · ');
}

function formatProviderIdentity(decision: ModelDecisionEventData): string | null {
  const identity = decision.providerIdentity;
  if (!identity) return null;
  const parts = [
    identity.sourceLabel
      ? `来源 ${identity.sourceLabel}`
      : identity.displayName
        ? `名称 ${identity.displayName}`
        : null,
    identity.transportLabel
      ? `协议 ${identity.transportLabel}`
      : identity.protocol
        ? `协议 ${identity.protocol}`
        : null,
    identity.endpoint ? `endpoint ${identity.endpoint}` : null,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(' · ') : null;
}

function formatVisibleTools(decision: ModelDecisionEventData): string | null {
  const strategy = decision.toolStrategy;
  if (!strategy) return null;
  const preview = strategy.toolNamesPreview?.length ? ` · ${strategy.toolNamesPreview.join(', ')}` : '';
  return `${strategy.visibleToolCount} 个可见工具${preview}`;
}

function formatMcpTools(decision: ModelDecisionEventData): string | null {
  const strategy = decision.toolStrategy;
  if (!strategy) return null;
  if (strategy.mcpToolCount <= 0) return '未选择 MCP';
  const servers = strategy.mcpServerIds?.length ? ` · ${strategy.mcpServerIds.join(', ')}` : '';
  return `${strategy.mcpToolCount} 个 MCP 工具${servers}`;
}

function formatProgrammaticTools(decision: ModelDecisionEventData): string | null {
  const strategy = decision.toolStrategy;
  if (!strategy) return null;
  const status = strategy.programmaticToolCalling === 'available' ? '可用' : '不可用';
  const savings = (() => {
    if (strategy.tokenSavings?.status === 'provider-reported' && strategy.tokenSavings.savedTokens !== undefined) {
      return ` · provider 回传节省 ${strategy.tokenSavings.savedTokens} tokens`;
    }
    if (strategy.tokenSavings?.status === 'estimated' && strategy.tokenSavings.savedTokens !== undefined) {
      return ` · 本地估算少占 ${strategy.tokenSavings.savedTokens} tokens 上下文`;
    }
    if (strategy.tokenSavings?.status === 'not-measured') {
      return ' · token saved 未计量';
    }
    return '';
  })();
  return `${status} · ${strategy.programmaticToolCount} 个程序化工具${savings}`;
}

function formatToolPolicyDetail(decision: ModelDecisionEventData): string | null {
  if (decision.toolPolicy === 'disabled-by-model') {
    return '当前执行模型不支持工具调用；本轮按纯文本执行，MCP / 程序化工具不会下发。';
  }
  if (decision.toolPolicy === 'unknown') {
    return '工具能力未知；以运行时实际下发工具为准。';
  }
  return null;
}

function formatToolTokenSavingsDetail(decision: ModelDecisionEventData): string | null {
  return decision.toolStrategy?.tokenSavings?.detail ?? null;
}

function formatToolTokenSavingsBasis(decision: ModelDecisionEventData): string | null {
  const basis = decision.toolStrategy?.tokenSavings?.basis;
  if (!basis) return null;
  if (basis.source !== 'tool-spec-local-estimate') return null;
  const fields = basis.fields.join('/');
  const preview = basis.previewToolCount !== undefined
    ? ` · 预览 ${basis.previewToolCount} 个`
    : '';
  return `本地工具规格估算 · ${basis.toolCount} 个工具 · 字段 ${fields}${preview}`;
}

function formatToolProviderUsage(decision: ModelDecisionEventData): string | null {
  const usage = decision.toolStrategy?.tokenSavings?.providerUsage;
  if (!usage) return null;
  const total = usage.totalTokens ?? (usage.inputTokens + usage.outputTokens);
  return `provider usage · 输入 ${usage.inputTokens} / 输出 ${usage.outputTokens} tokens · 合计 ${total}`;
}

function formatToolProviderReport(decision: ModelDecisionEventData): string | null {
  const report = decision.toolStrategy?.tokenSavings?.providerReport;
  if (!report) return null;
  return `provider-reported saved tokens · ${report.savedTokens} tokens`;
}

function formatToolTokenSavingsMeasurement(decision: ModelDecisionEventData): string | null {
  const measurement = decision.toolStrategy?.tokenSavings?.measurement;
  if (!measurement) return null;
  const savingsSource = (() => {
    if (measurement.savingsSource === 'tool-spec-local-estimate') return '上下文少占=本地估算';
    if (measurement.savingsSource === 'provider-reported') return '节省=provider 回传';
    return '节省=未计量';
  })();
  const usageSource = measurement.usageSource === 'model-response-usage'
    ? '用量=provider usage'
    : '用量=未回传';
  const reported = measurement.providerReportedSavings
    ? 'provider 已回传 saved tokens'
    : '无 provider-reported saved tokens';
  return `${savingsSource} · ${usageSource} · ${reported}`;
}

function formatToolTokenSavingsBoundary(decision: ModelDecisionEventData): string | null {
  const savings = decision.toolStrategy?.tokenSavings;
  if (!savings?.measurement) return null;
  if (savings.measurement.providerReportedSavings) return null;
  if (savings.status === 'estimated' || savings.measurement.savingsSource === 'tool-spec-local-estimate') {
    return 'saved tokens 是工具规格少占上下文的本地估算，不等同 provider 账单节省；真实成本看 provider usage。';
  }
  return null;
}

function formatExternalEngineRuntime(engine?: ModelExternalEngineSnapshot): string | null {
  if (!engine) return null;
  return [
    ENGINE_KIND_LABELS[engine.kind] ?? engine.kind,
    ENGINE_INSTALL_LABELS[engine.installState],
    ENGINE_RUNTIME_LABELS[engine.runtimeState],
    engine.executable ? '可执行' : '不可执行',
  ].filter(Boolean).join(' · ');
}

function formatExternalEngineReliability(engine?: ModelExternalEngineSnapshot): string | null {
  const reliability = engine?.reliability;
  if (!reliability) return null;
  return [
    ENGINE_CLI_LABELS[reliability.cliStatus],
    ENGINE_AUTH_LABELS[reliability.authState],
    ENGINE_QUOTA_LABELS[reliability.quotaState],
    ENGINE_STREAM_LABELS[reliability.streamingMode],
    reliability.partialMessages ? 'partial messages' : null,
    ENGINE_TOOL_LABELS[reliability.toolSupport],
    reliability.mcpBridge ? 'MCP bridge' : null,
  ].filter(Boolean).join(' · ');
}

function formatExternalEngineTranscript(engine?: ModelExternalEngineSnapshot): string | null {
  const reliability = engine?.reliability;
  if (!reliability) return null;
  return ENGINE_TRANSCRIPT_LABELS[reliability.transcriptMode];
}

function formatExternalEngineFailure(engine?: ModelExternalEngineSnapshot): string | null {
  const failure = engine?.failure;
  if (!failure) return null;
  return [
    failure.category,
    failure.reason,
    formatFailureAge(failure.occurredAt),
    failure.statusCode !== undefined ? `HTTP ${failure.statusCode}` : null,
    failure.exitCode !== undefined && failure.exitCode !== null ? `exit ${failure.exitCode}` : null,
    failure.retryable ? '可重试' : '需处理',
  ].filter(Boolean).join(' · ');
}

function DetailRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex min-w-0 items-start gap-2">
      <span className="w-11 shrink-0 text-zinc-500">{label}</span>
      <span className="min-w-0 text-zinc-300">{value}</span>
    </div>
  );
}

export const RouteTraceChip: React.FC<{ decision: ModelDecisionEventData; defaultExpanded?: boolean }> = ({ decision, defaultExpanded = false }) => {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const requested = formatModel(decision.requestedProvider, decision.requestedModel);
  const resolved = formatModel(decision.resolvedProvider, decision.resolvedModel);
  const changed = requested !== resolved;
  const label = REASON_LABELS[decision.reason];
  const summary = decision.strategySummary ?? (changed ? `${requested} -> ${resolved}` : resolved);
  const capabilityLabels = decision.capabilityNeeds?.map((need) => CAPABILITY_LABELS[need]).join(' / ');
  const complexityScore = formatComplexityScore(decision.complexityScore);
  const providerHealth = formatProviderHealth(decision);
  const providerIdentity = formatProviderIdentity(decision);
  const visibleTools = formatVisibleTools(decision);
  const mcpTools = formatMcpTools(decision);
  const programmaticTools = formatProgrammaticTools(decision);
  const toolPolicyDetail = formatToolPolicyDetail(decision);
  const toolTokenSavingsDetail = formatToolTokenSavingsDetail(decision);
  const toolTokenSavingsBasis = formatToolTokenSavingsBasis(decision);
  const toolProviderUsage = formatToolProviderUsage(decision);
  const toolProviderReport = formatToolProviderReport(decision);
  const toolTokenMeasurement = formatToolTokenSavingsMeasurement(decision);
  const toolTokenBoundary = formatToolTokenSavingsBoundary(decision);
  const externalEngineRuntime = formatExternalEngineRuntime(decision.externalEngine);
  const externalEngineReliability = formatExternalEngineReliability(decision.externalEngine);
  const externalEngineTranscript = formatExternalEngineTranscript(decision.externalEngine);
  const externalEngineFailure = formatExternalEngineFailure(decision.externalEngine);

  return (
    <div className="max-w-full min-w-0">
      <button
        type="button"
        className={`inline-flex max-w-full items-center gap-1.5 rounded-md border px-2 py-1 text-[11px] leading-none transition-colors hover:border-white/20 ${getToneClass(decision.reason)}`}
        title={summary}
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
        data-testid="route-trace-chip"
      >
        {expanded
          ? <ChevronDown className="h-3 w-3 shrink-0 opacity-70" />
          : <ChevronRight className="h-3 w-3 shrink-0 opacity-70" />}
        {decision.reason === 'fallback-availability'
          ? <AlertTriangle className="h-3 w-3 shrink-0" />
          : <GitBranch className="h-3 w-3 shrink-0" />}
        <span className="shrink-0">{label}</span>
        <span className="min-w-0 truncate font-mono text-[10px] opacity-80">
          {changed ? `${decision.requestedModel} -> ${decision.resolvedModel}` : decision.resolvedModel}
        </span>
      </button>
      {expanded && (
        <div
          className="mt-1 max-w-xl rounded-md border border-white/[0.08] bg-zinc-950/70 px-2.5 py-2 text-[11px] leading-relaxed text-zinc-300"
          data-testid="route-trace-details"
        >
          <div className="mb-1 text-zinc-200">{summary}</div>
          <div className="grid gap-1 sm:grid-cols-2">
	            <DetailRow label="请求" value={<span className="font-mono text-[10px]">{requested}</span>} />
	            <DetailRow label="实际" value={<span className="font-mono text-[10px]">{resolved}</span>} />
	            {providerIdentity && <DetailRow label="Provider" value={providerIdentity} />}
	            {decision.taskClass && <DetailRow label="任务" value={TASK_LABELS[decision.taskClass]} />}
            {complexityScore && <DetailRow label="复杂度" value={complexityScore} />}
            <DetailRow label="计费" value={BILLING_LABELS[decision.billingMode]} />
            {decision.costPolicy && <DetailRow label="成本" value={COST_LABELS[decision.costPolicy]} />}
            {decision.speedPolicy && <DetailRow label="速度" value={SPEED_LABELS[decision.speedPolicy]} />}
            {decision.toolPolicy && <DetailRow label="工具" value={TOOL_LABELS[decision.toolPolicy]} />}
            {toolPolicyDetail && <DetailRow label="工具策略" value={toolPolicyDetail} />}
            {visibleTools && <DetailRow label="工具数" value={<span className="font-mono text-[10px]">{visibleTools}</span>} />}
            {mcpTools && <DetailRow label="MCP" value={<span className="font-mono text-[10px]">{mcpTools}</span>} />}
            {programmaticTools && <DetailRow label="程序化" value={programmaticTools} />}
            {toolTokenSavingsBasis && <DetailRow label="估算" value={toolTokenSavingsBasis} />}
            {toolProviderUsage && <DetailRow label="用量" value={toolProviderUsage} />}
            {toolProviderReport && <DetailRow label="回传" value={toolProviderReport} />}
            {toolTokenMeasurement && <DetailRow label="计量" value={toolTokenMeasurement} />}
            {toolTokenBoundary && <DetailRow label="边界" value={toolTokenBoundary} />}
            {toolTokenSavingsDetail && <DetailRow label="口径" value={toolTokenSavingsDetail} />}
            {capabilityLabels && <DetailRow label="能力" value={capabilityLabels} />}
            {providerHealth && <DetailRow label="状态" value={providerHealth} />}
            {externalEngineRuntime && <DetailRow label="引擎" value={externalEngineRuntime} />}
            {externalEngineReliability && <DetailRow label="链路" value={externalEngineReliability} />}
            {externalEngineTranscript && <DetailRow label="转写" value={externalEngineTranscript} />}
            {externalEngineFailure && <DetailRow label="失败" value={externalEngineFailure} />}
            {decision.externalEngine?.failure?.suggestion && <DetailRow label="建议" value={decision.externalEngine.failure.suggestion} />}
            {decision.externalEngine?.version && <DetailRow label="版本" value={decision.externalEngine.version} />}
          </div>
        </div>
      )}
    </div>
  );
};
