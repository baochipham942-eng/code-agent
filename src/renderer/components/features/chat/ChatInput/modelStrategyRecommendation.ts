import type { AgentEngineFailureDiagnostics, AgentEngineKind } from '@shared/contract/agentEngine';
import type { AgentEngineSessionMetadata } from '@shared/contract/agentEngine';
import type { BillingMode } from '@shared/contract/modelDecision';
import type { ModelProvider } from '@shared/contract/model';
import type { ModelDomainCapability } from '@shared/constants';

export type ModelStrategyRecommendationAction = 'enable-auto' | 'switch-model' | 'switch-native-engine';
export type ModelStrategyRecommendationTone = 'info' | 'warning';
export type ModelStrategyProviderHealthState = 'healthy' | 'recovering' | 'unknown' | 'degraded' | 'unavailable';
export type ModelStrategyModelSpeed = 'fast' | 'standard' | 'slow' | 'unknown';
export type ModelStrategyRecommendationTaskKind =
  | 'simple'
  | 'vision'
  | 'long-context'
  | 'search'
  | 'tool'
  | 'provider-health'
  | 'external-failure'
  | 'external-attachment'
  | 'external-write';

export type ModelStrategyRecommendationFeedbackOutcome = 'applied' | 'dismissed' | 'apply-failed';

export interface ModelStrategyProviderHealthSnapshot {
  status?: string;
  latencyP50?: number;
  errorRate?: number;
}

export interface ModelStrategyCandidate {
  provider: ModelProvider;
  providerLabel: string;
  model: string;
  modelLabel: string;
  capabilities: ModelDomainCapability[];
  providerHealth?: ModelStrategyProviderHealthSnapshot | null;
}

export interface ModelStrategyRecommendationFactor {
  label: string;
  value: string;
}

export interface ModelStrategyRecommendationTaskSignal {
  taskKind: ModelStrategyRecommendationTaskKind;
  recommendationReason: string;
  inputFingerprint: string;
  requiredCapabilities: ModelDomainCapability[];
  engineKind: AgentEngineKind;
  currentProvider?: ModelProvider;
  currentModel?: string;
  billingMode?: BillingMode;
  modelSpeed?: ModelStrategyModelSpeed;
  providerHealthState?: ModelStrategyProviderHealthState;
}

export interface ModelStrategyRecommendation {
  key: string;
  tone: ModelStrategyRecommendationTone;
  title: string;
  body: string;
  strategyFactors?: ModelStrategyRecommendationFactor[];
  taskSignal?: ModelStrategyRecommendationTaskSignal;
  primaryAction?: ModelStrategyRecommendationAction;
  primaryLabel?: string;
  targetProvider?: ModelProvider;
  targetModel?: string;
  targetModelLabel?: string;
  targetProviderLabel?: string;
}

export interface ModelStrategySwitchModelRequest {
  provider: ModelProvider;
  model: string;
  adaptive: boolean;
}

export type ModelStrategyEngineSelectionRequest = Pick<
  AgentEngineSessionMetadata,
  'kind' | 'permissionProfile'
>;

export interface ModelStrategyRecommendationInput {
  inputValue: string;
  hasImageAttachments: boolean;
  engineKind: AgentEngineKind;
  modelLabel: string;
  modelCapabilities: ModelDomainCapability[];
  adaptiveEnabled: boolean;
  currentProvider?: ModelProvider;
  currentModel?: string;
  providerLabel?: string;
  providerHealth?: ModelStrategyProviderHealthSnapshot | null;
  billingMode?: BillingMode;
  currentModelSpeed?: ModelStrategyModelSpeed;
  externalEngineFailure?: AgentEngineFailureDiagnostics | null;
  candidates?: ModelStrategyCandidate[];
}

export function buildModelStrategySwitchModelRequest(args: {
  recommendation: ModelStrategyRecommendation | null | undefined;
  currentProvider: ModelProvider;
  currentModel: string;
}): ModelStrategySwitchModelRequest | null {
  if (!args.recommendation?.primaryAction) return null;
  if (args.recommendation.primaryAction === 'switch-model') {
    if (!args.recommendation.targetProvider || !args.recommendation.targetModel) return null;
    return {
      provider: args.recommendation.targetProvider,
      model: args.recommendation.targetModel,
      adaptive: false,
    };
  }
  if (args.recommendation.primaryAction === 'enable-auto') {
    return {
      provider: args.currentProvider,
      model: args.currentModel,
      adaptive: true,
    };
  }
  return null;
}

export function buildModelStrategyEngineSelectionRequest(
  recommendation: ModelStrategyRecommendation | null | undefined,
): ModelStrategyEngineSelectionRequest | null {
  if (recommendation?.primaryAction !== 'switch-native-engine') return null;
  return {
    kind: 'native',
    permissionProfile: 'default',
  };
}

export type ApplyModelStrategyRecommendationResult =
  | 'noop'
  | 'switch-native-engine'
  | 'switch-model'
  | 'enable-auto'
  | 'failed';

export interface ModelStrategyRecommendationFeedbackEvent {
  outcome: ModelStrategyRecommendationFeedbackOutcome;
  tone: ModelStrategyRecommendationTone;
  taskKind?: ModelStrategyRecommendationTaskKind;
  recommendationReason?: string;
  inputFingerprint?: string;
  requiredCapabilities?: ModelDomainCapability[];
  engineKind?: AgentEngineKind;
  currentProvider?: ModelProvider;
  currentModel?: string;
  billingMode?: BillingMode;
  modelSpeed?: ModelStrategyModelSpeed;
  providerHealthState?: ModelStrategyProviderHealthState;
  primaryAction?: ModelStrategyRecommendationAction;
  targetProvider?: ModelProvider;
  targetModel?: string;
}

export interface ApplyModelStrategyRecommendationOptions {
  currentSessionId: string | null | undefined;
  recommendation: ModelStrategyRecommendation | null | undefined;
  currentProvider: ModelProvider;
  currentModel: string;
  switchModel: (request: { sessionId: string } & ModelStrategySwitchModelRequest) => Promise<{
    success?: boolean;
    error?: { message?: string };
  } | undefined>;
  updateSessionEngine: (sessionId: string, selection: ModelStrategyEngineSelectionRequest) => Promise<unknown>;
  applyOverride: (override: ModelStrategySwitchModelRequest | null) => void;
  dismiss: (key: string) => void;
  recordFeedback?: (feedback: ModelStrategyRecommendationFeedbackEvent) => void;
  notifySuccess: (message: string) => void;
  notifyError: (message: string) => void;
}

export function buildModelStrategyRecommendationFeedback(
  recommendation: ModelStrategyRecommendation | null | undefined,
  outcome: ModelStrategyRecommendationFeedbackOutcome,
): ModelStrategyRecommendationFeedbackEvent | null {
  if (!recommendation) return null;
  return {
    outcome,
    tone: recommendation.tone,
    ...(recommendation.taskSignal ? {
      taskKind: recommendation.taskSignal.taskKind,
      recommendationReason: recommendation.taskSignal.recommendationReason,
      inputFingerprint: recommendation.taskSignal.inputFingerprint,
      requiredCapabilities: recommendation.taskSignal.requiredCapabilities,
      engineKind: recommendation.taskSignal.engineKind,
      ...(recommendation.taskSignal.currentProvider ? { currentProvider: recommendation.taskSignal.currentProvider } : {}),
      ...(recommendation.taskSignal.currentModel ? { currentModel: recommendation.taskSignal.currentModel } : {}),
      ...(recommendation.taskSignal.billingMode ? { billingMode: recommendation.taskSignal.billingMode } : {}),
      ...(recommendation.taskSignal.modelSpeed ? { modelSpeed: recommendation.taskSignal.modelSpeed } : {}),
      ...(recommendation.taskSignal.providerHealthState ? { providerHealthState: recommendation.taskSignal.providerHealthState } : {}),
    } : {}),
    ...(recommendation.primaryAction ? { primaryAction: recommendation.primaryAction } : {}),
    ...(recommendation.targetProvider ? { targetProvider: recommendation.targetProvider } : {}),
    ...(recommendation.targetModel ? { targetModel: recommendation.targetModel } : {}),
  };
}

export async function applyModelStrategyRecommendationAction({
  currentSessionId,
  recommendation,
  currentProvider,
  currentModel,
  switchModel,
  updateSessionEngine,
  applyOverride,
  dismiss,
  recordFeedback,
  notifySuccess,
  notifyError,
}: ApplyModelStrategyRecommendationOptions): Promise<ApplyModelStrategyRecommendationResult> {
  if (!currentSessionId || !recommendation) return 'noop';
  try {
    if (recommendation.primaryAction === 'switch-native-engine') {
      const engineSelection = buildModelStrategyEngineSelectionRequest(recommendation);
      if (!engineSelection) return 'noop';
      await updateSessionEngine(currentSessionId, engineSelection);
      applyOverride(null);
      dismiss(recommendation.key);
      const feedback = buildModelStrategyRecommendationFeedback(recommendation, 'applied');
      if (feedback) recordFeedback?.(feedback);
      notifySuccess('已切回 Native 主任务模型');
      return 'switch-native-engine';
    }

    const switchPayload = buildModelStrategySwitchModelRequest({
      recommendation,
      currentProvider,
      currentModel,
    });
    if (!switchPayload) return 'noop';

    const res = await switchModel({
      sessionId: currentSessionId,
      ...switchPayload,
    });
    if (!res?.success) {
      const feedback = buildModelStrategyRecommendationFeedback(recommendation, 'apply-failed');
      if (feedback) recordFeedback?.(feedback);
      notifyError('采用模型建议失败: ' + (res?.error?.message ?? '未知错误'));
      return 'failed';
    }

    applyOverride(switchPayload);
    dismiss(recommendation.key);
    const feedback = buildModelStrategyRecommendationFeedback(recommendation, 'applied');
    if (feedback) recordFeedback?.(feedback);
    if (recommendation.primaryAction === 'switch-model') {
      notifySuccess(`已切换到 ${recommendation.targetProviderLabel ?? switchPayload.provider} / ${recommendation.targetModelLabel ?? switchPayload.model}`);
      return 'switch-model';
    }

    notifySuccess('已采用自动模型策略');
    return 'enable-auto';
  } catch (error) {
    const feedback = buildModelStrategyRecommendationFeedback(recommendation, 'apply-failed');
    if (feedback) recordFeedback?.(feedback);
    notifyError('采用模型建议失败: ' + (error instanceof Error ? error.message : '未知错误'));
    return 'failed';
  }
}

function hasCapability(capabilities: ModelDomainCapability[], capability: ModelDomainCapability): boolean {
  return capabilities.includes(capability);
}

function isSlashCommand(input: string): boolean {
  return /^\/\S*/.test(input.trim());
}

function looksLikeCodeTask(input: string): boolean {
  return /```|重构|修复|实现|代码|测试|函数|组件|\b(hook|api|repo|typescript|javascript|python|bug|diff)\b/i.test(input);
}

function looksLikeArtifactTask(input: string): boolean {
  return /artifact|图表|表格|文档|报告|ppt|excel|dashboard|生成文件|导出/i.test(input);
}

function looksLikeLongContextTask(input: string): boolean {
  return input.length > 2200 || /长上下文|大文件|整个项目|全仓|多文件|大量文件|long context|large context/i.test(input);
}

function looksLikeSearchTask(input: string): boolean {
  return /搜索|查找|联网|最新|官网|release note|news|price|weather|search|browse|web/i.test(input);
}

function looksLikeSimpleTask(input: string): boolean {
  const trimmed = input.trim();
  if (!trimmed || trimmed.length > 120 || isSlashCommand(trimmed)) return false;
  return !looksLikeCodeTask(trimmed)
    && !looksLikeArtifactTask(trimmed)
    && !looksLikeLongContextTask(trimmed)
    && !looksLikeSearchTask(trimmed);
}

function modelLooksFast(model?: string, label?: string): boolean {
  const text = `${model ?? ''} ${label ?? ''}`.toLowerCase();
  return /flash|fast|mini|nano|lite|turbo|haiku|quick/.test(text);
}

function modelLooksSlowOrHighCapacity(
  modelCapabilities: ModelDomainCapability[],
  model?: string,
  label?: string,
): boolean {
  const text = `${model ?? ''} ${label ?? ''}`.toLowerCase();
  return modelCapabilities.includes('reasoning')
    || /opus|max|thinking|reason|r1|o1|o3|o4|gpt-5|gpt-4\.5|glm-5/.test(text);
}

function resolveModelSpeed(input: ModelStrategyRecommendationInput): ModelStrategyModelSpeed {
  if (input.currentModelSpeed) return input.currentModelSpeed;
  if (modelLooksFast(input.currentModel, input.modelLabel)) return 'fast';
  if (modelLooksSlowOrHighCapacity(input.modelCapabilities, input.currentModel, input.modelLabel)) {
    return 'slow';
  }
  return 'standard';
}

function getEngineLabel(engineKind: AgentEngineKind): string {
  switch (engineKind) {
    case 'claude_code':
      return 'Claude Code';
    case 'codex_cli':
      return 'Codex CLI';
    default:
      return '当前引擎';
  }
}

const ENGINE_FAILURE_LABELS: Record<AgentEngineFailureDiagnostics['category'], string> = {
  auth: '认证失败',
  quota: '额度受限',
  timeout: '运行超时',
  network: '网络异常',
  permission: '权限不足',
  missing_cli: 'CLI 不可用',
  runtime: '运行失败',
  unknown: '运行失败',
};

function formatFailureAge(occurredAt?: number, now = Date.now()): string {
  if (typeof occurredAt !== 'number' || !Number.isFinite(occurredAt)) return '最近失败';
  const ageMs = Math.max(0, now - occurredAt);
  if (ageMs < 60_000) return '刚刚失败';
  if (ageMs < 60 * 60_000) return `${Math.floor(ageMs / 60_000)} 分钟前失败`;
  if (ageMs < 24 * 60 * 60_000) return `${Math.floor(ageMs / (60 * 60_000))} 小时前失败`;
  return `${Math.floor(ageMs / (24 * 60 * 60_000))} 天前失败`;
}

function normalizeProviderHealthState(status?: string): ModelStrategyProviderHealthState {
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

const PROVIDER_HEALTH_LABELS: Record<ModelStrategyProviderHealthState, string> = {
  healthy: '健康',
  recovering: '恢复中',
  unknown: '未检测',
  degraded: '降级',
  unavailable: '不可用',
};

const CAPABILITY_LABELS: Record<ModelDomainCapability, string> = {
  tool: '工具',
  vision: '视觉',
  reasoning: '推理',
  'long-context': '长上下文',
  search: '搜索',
};

function formatCapabilityList(capabilities: ModelDomainCapability[]): string {
  return capabilities.map((capability) => CAPABILITY_LABELS[capability] ?? capability).join(' / ');
}

function formatProviderHealthState(health?: ModelStrategyProviderHealthSnapshot | null): string {
  return PROVIDER_HEALTH_LABELS[normalizeProviderHealthState(health?.status)];
}

function formatProviderHealthMetric(health?: ModelStrategyProviderHealthSnapshot | null): string | null {
  const parts = [
    typeof health?.latencyP50 === 'number' && Number.isFinite(health.latencyP50)
      ? `P50 ${Math.round(health.latencyP50)}ms`
      : null,
    typeof health?.errorRate === 'number' && Number.isFinite(health.errorRate)
      ? `错误率 ${Math.round(health.errorRate * 100)}%`
      : null,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join('，') : null;
}

function candidateHasCapability(candidate: ModelStrategyCandidate, capability: ModelDomainCapability): boolean {
  return candidate.capabilities.includes(capability);
}

function providerHealthRank(health?: ModelStrategyProviderHealthSnapshot | null): number {
  switch (normalizeProviderHealthState(health?.status)) {
    case 'healthy':
      return 0;
    case 'recovering':
      return 1;
    case 'unknown':
      return 2;
    case 'degraded':
      return 3;
    case 'unavailable':
      return 4;
    default:
      return 2;
  }
}

function selectCandidate(args: {
  candidates?: ModelStrategyCandidate[];
  currentProvider?: ModelProvider;
  currentModel?: string;
  requiredCapabilities: ModelDomainCapability[];
  maxProviderHealthRank?: number;
  preferFast?: boolean;
}): ModelStrategyCandidate | null {
  const candidates = args.candidates ?? [];
  const maxProviderHealthRank = args.maxProviderHealthRank ?? 2;
  const matching = candidates
    .filter((candidate) => candidate.provider !== args.currentProvider || candidate.model !== args.currentModel)
    .filter((candidate) => providerHealthRank(candidate.providerHealth) <= maxProviderHealthRank)
    .filter((candidate) => args.requiredCapabilities.every((capability) => candidateHasCapability(candidate, capability)))
    .sort((a, b) => {
      const healthOrder = providerHealthRank(a.providerHealth) - providerHealthRank(b.providerHealth);
      if (healthOrder !== 0) return healthOrder;
      if (args.preferFast) {
        const speedOrder = Number(modelLooksFast(b.model, b.modelLabel)) - Number(modelLooksFast(a.model, a.modelLabel));
        if (speedOrder !== 0) return speedOrder;
      }
      return a.providerLabel.localeCompare(b.providerLabel) || a.modelLabel.localeCompare(b.modelLabel);
    });
  return matching[0] ?? null;
}

function selectFastCandidate(args: {
  candidates?: ModelStrategyCandidate[];
  currentProvider?: ModelProvider;
  currentModel?: string;
}): ModelStrategyCandidate | null {
  const matching = (args.candidates ?? [])
    .filter((candidate) => candidate.provider !== args.currentProvider || candidate.model !== args.currentModel)
    .filter((candidate) => providerHealthRank(candidate.providerHealth) <= 1)
    .filter((candidate) => modelLooksFast(candidate.model, candidate.modelLabel))
    .sort((a, b) => {
      const healthOrder = providerHealthRank(a.providerHealth) - providerHealthRank(b.providerHealth);
      if (healthOrder !== 0) return healthOrder;
      return a.providerLabel.localeCompare(b.providerLabel) || a.modelLabel.localeCompare(b.modelLabel);
    });
  return matching[0] ?? null;
}

function deriveTaskRequiredCapabilities(
  input: Pick<ModelStrategyRecommendationInput, 'hasImageAttachments'>,
  text: string,
): ModelDomainCapability[] {
  const required = new Set<ModelDomainCapability>();
  if (input.hasImageAttachments) required.add('vision');
  if (looksLikeLongContextTask(text)) required.add('long-context');
  if (looksLikeSearchTask(text)) required.add('search');
  if (looksLikeCodeTask(text) || looksLikeArtifactTask(text)) required.add('tool');
  return Array.from(required);
}

function buildTaskKeySegment(args: {
  simpleTask: boolean;
  requiredCapabilities: ModelDomainCapability[];
}): string {
  if (args.requiredCapabilities.length > 0) {
    return `task:${args.requiredCapabilities.join('+')}`;
  }
  if (args.simpleTask) return 'task:simple';
  return 'task:general';
}

function buildTaskInputKey(text: string, fallback: string): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  return (normalized || fallback).slice(0, 60);
}

function hashTaskInput(text: string): string {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function buildTaskInputFingerprint(text: string, fallback: string): string {
  const normalized = text.replace(/\s+/g, ' ').trim() || fallback;
  return `len:${normalized.length}:h:${hashTaskInput(normalized)}`;
}

function buildTaskSignal(args: {
  input: ModelStrategyRecommendationInput;
  text: string;
  fallback: string;
  taskKind: ModelStrategyRecommendationTaskKind;
  recommendationReason: string;
  requiredCapabilities?: ModelDomainCapability[];
  providerHealthState?: ModelStrategyProviderHealthState;
  modelSpeed?: ModelStrategyModelSpeed;
}): ModelStrategyRecommendationTaskSignal {
  return {
    taskKind: args.taskKind,
    recommendationReason: args.recommendationReason,
    inputFingerprint: buildTaskInputFingerprint(args.text, args.fallback),
    requiredCapabilities: args.requiredCapabilities ?? [],
    engineKind: args.input.engineKind,
    ...(args.input.currentProvider ? { currentProvider: args.input.currentProvider } : {}),
    ...(args.input.currentModel ? { currentModel: args.input.currentModel } : {}),
    ...(args.input.billingMode ? { billingMode: args.input.billingMode } : {}),
    ...(args.modelSpeed ? { modelSpeed: args.modelSpeed } : {}),
    ...(args.providerHealthState ? { providerHealthState: args.providerHealthState } : {}),
  };
}

function buildSwitchModelRecommendation(args: {
  key: string;
  title: string;
  body: string;
  candidate: ModelStrategyCandidate | null;
  strategyFactors?: ModelStrategyRecommendationFactor[];
  requiredCapabilities?: ModelDomainCapability[];
  taskSignal?: ModelStrategyRecommendationTaskSignal;
}): ModelStrategyRecommendation {
  const strategyFactors = [
    ...(args.strategyFactors ?? []),
    ...(args.requiredCapabilities?.length
      ? [{ label: '需要', value: formatCapabilityList(args.requiredCapabilities) }]
      : []),
    ...(args.candidate
      ? [
        { label: '候选', value: `${args.candidate.providerLabel} / ${args.candidate.modelLabel}` },
        { label: '候选状态', value: formatProviderHealthState(args.candidate.providerHealth) },
      ]
      : []),
  ];
  return {
    key: args.key,
    tone: 'warning',
    title: args.title,
    body: args.candidate
      ? `${args.body} 建议切到 ${args.candidate.providerLabel} / ${args.candidate.modelLabel}。`
      : args.body,
    ...(strategyFactors.length > 0 ? { strategyFactors } : {}),
    ...(args.taskSignal ? { taskSignal: args.taskSignal } : {}),
    ...(args.candidate
      ? {
        primaryAction: 'switch-model' as const,
        primaryLabel: '采用建议',
        targetProvider: args.candidate.provider,
        targetModel: args.candidate.model,
        targetModelLabel: args.candidate.modelLabel,
        targetProviderLabel: args.candidate.providerLabel,
      }
      : {}),
  };
}

function buildSimpleTaskRecommendation(
  input: ModelStrategyRecommendationInput,
  text: string,
): ModelStrategyRecommendation | null {
  if (!looksLikeSimpleTask(text)) return null;

  const billingMode = input.billingMode ?? 'payg';
  const modelSpeed = resolveModelSpeed(input);
  const fastCandidate = modelSpeed === 'slow'
    ? selectFastCandidate({
      candidates: input.candidates,
      currentProvider: input.currentProvider,
      currentModel: input.currentModel,
    })
    : null;

  if ((billingMode === 'plan' || billingMode === 'free' || billingMode === 'unknown')
    && fastCandidate) {
    const billingCopy = billingMode === 'unknown' ? '计费未知时' : '当前计费模式下';
    return buildSwitchModelRecommendation({
      key: `simple:fast:${billingMode}:${input.modelLabel}:${fastCandidate.provider}:${fastCandidate.model}`,
      title: '简单任务建议快模型',
      body: `这轮像简单问答。当前 ${input.modelLabel} 偏重，${billingCopy}自动策略不一定会为了省钱切模型，快模型更适合降低等待。`,
      candidate: fastCandidate,
      taskSignal: buildTaskSignal({
        input,
        text,
        fallback: 'simple-task',
        taskKind: 'simple',
        recommendationReason: 'simple-fast-model',
        modelSpeed,
      }),
      strategyFactors: [
        { label: '任务', value: '简单问答' },
        { label: '计费', value: billingMode === 'unknown' ? '未知' : billingMode === 'plan' ? '套餐' : '免费' },
        { label: '速度', value: '当前偏重' },
      ],
    });
  }

  if (input.adaptiveEnabled) return null;
  if (billingMode !== 'payg') return null;

  const heavyModelNote = modelSpeed === 'slow'
    ? `当前 ${input.modelLabel} 偏重，按量计费下可能更慢或更贵。`
    : '';
  return {
    key: `simple:auto:${billingMode}:${modelSpeed}:${text}`,
    tone: 'info',
    title: modelSpeed === 'slow' ? '简单任务不必占用重模型' : '简单任务可用自动策略',
    body: `这轮像简单问答。${heavyModelNote}自动模式会在按量计费下优先快模型，降低等待和成本。`,
    taskSignal: buildTaskSignal({
      input,
      text,
      fallback: 'simple-task',
      taskKind: 'simple',
      recommendationReason: 'simple-auto-strategy',
      modelSpeed,
    }),
    strategyFactors: [
      { label: '任务', value: '简单问答' },
      { label: '计费', value: '按量' },
      { label: '速度', value: modelSpeed === 'slow' ? '当前偏重' : '标准' },
    ],
    primaryAction: 'enable-auto',
    primaryLabel: '采用自动',
  };
}

export function buildModelStrategyRecommendation(
  input: ModelStrategyRecommendationInput,
): ModelStrategyRecommendation | null {
  const text = input.inputValue.trim();
  if (!text && !input.hasImageAttachments) return null;
  const taskRequiredCapabilities = deriveTaskRequiredCapabilities(input, text);
  const simpleTask = taskRequiredCapabilities.length === 0 && looksLikeSimpleTask(text);

  if (input.engineKind !== 'native') {
    const engineLabel = getEngineLabel(input.engineKind);
    if (input.externalEngineFailure) {
      const failure = input.externalEngineFailure;
      const failureAge = formatFailureAge(failure.occurredAt);
      return {
        key: `external-failure:${input.engineKind}:${failure.reason}:${failure.occurredAt ?? 'unknown'}`,
        tone: 'warning',
        title: `${engineLabel} 最近运行失败`,
        body: `${engineLabel} ${failureAge}：${ENGINE_FAILURE_LABELS[failure.category]}（${failure.reason}）。${failure.suggestion}`,
        taskSignal: buildTaskSignal({
          input,
          text,
          fallback: 'external-failure',
          taskKind: 'external-failure',
          recommendationReason: `${failure.category}:${failure.reason}`,
          requiredCapabilities: taskRequiredCapabilities,
        }),
        strategyFactors: [
          { label: '引擎', value: engineLabel },
          { label: '失败', value: ENGINE_FAILURE_LABELS[failure.category] },
          { label: '时间', value: failureAge },
          { label: '恢复', value: failure.retryable ? '可重试' : '需处理' },
        ],
        ...(failure.retryable ? {} : {
          primaryAction: 'switch-native-engine' as const,
          primaryLabel: '切回 Native',
        }),
      };
    }
    if (input.hasImageAttachments) {
      return {
        key: `external-attachments:${input.engineKind}:${buildTaskInputKey(text, 'attachment')}`,
        tone: 'warning',
        title: '外部引擎暂不接收附件',
        body: `当前 ${engineLabel} 通道只接收文本 prompt。图片任务请先去掉附件，或切回 Native 主任务模型使用视觉 fallback。`,
        taskSignal: buildTaskSignal({
          input,
          text,
          fallback: 'attachment',
          taskKind: 'external-attachment',
          recommendationReason: 'external-engine-text-only',
          requiredCapabilities: ['vision'],
        }),
        strategyFactors: [
          { label: '引擎', value: engineLabel },
          { label: '输入', value: '图片附件' },
          { label: '链路', value: '文本 prompt' },
        ],
        primaryAction: 'switch-native-engine',
        primaryLabel: '切回 Native',
      };
    }
    if (looksLikeCodeTask(text) || looksLikeArtifactTask(text)) {
      return {
        key: `external-readonly:${input.engineKind}:${buildTaskInputKey(text, 'write-task')}`,
        tone: 'warning',
        title: '外部引擎当前是只读链路',
        body: `这轮看起来需要代码或产物落地。当前 ${engineLabel} 走只读 CLI 链路，不会直接修改工作区；需要写文件时建议切回 Native 主任务模型。`,
        taskSignal: buildTaskSignal({
          input,
          text,
          fallback: 'write-task',
          taskKind: 'external-write',
          recommendationReason: 'external-engine-readonly',
          requiredCapabilities: ['tool'],
        }),
        strategyFactors: [
          { label: '引擎', value: engineLabel },
          { label: '任务', value: '代码/产物' },
          { label: '链路', value: '只读 CLI' },
        ],
        primaryAction: 'switch-native-engine',
        primaryLabel: '切回 Native',
      };
    }
    return null;
  }

  const providerHealthState = normalizeProviderHealthState(input.providerHealth?.status);
  if (providerHealthState === 'degraded' || providerHealthState === 'unavailable') {
    const providerLabel = input.providerLabel || '当前 provider';
    const metric = formatProviderHealthMetric(input.providerHealth);
    const taskKeySegment = buildTaskKeySegment({
      simpleTask,
      requiredCapabilities: taskRequiredCapabilities,
    });
    const candidate = selectCandidate({
      candidates: input.candidates,
      currentProvider: input.currentProvider,
      currentModel: input.currentModel,
      requiredCapabilities: taskRequiredCapabilities,
      maxProviderHealthRank: 1,
      preferFast: simpleTask,
    });
    if (candidate) {
      return {
        key: `provider-health:${taskKeySegment}:${providerLabel}:${providerHealthState}:${metric ?? 'no-metric'}:${candidate.provider}:${candidate.model}`,
        tone: 'warning',
        title: providerHealthState === 'unavailable' ? '当前 provider 不可用' : '当前 provider 状态降级',
        body: `${providerLabel} 最近状态为${providerHealthState === 'unavailable' ? '不可用' : '降级'}${metric ? `（${metric}）` : ''}。这轮可能变慢或触发 fallback，建议切到 ${candidate.providerLabel} / ${candidate.modelLabel}。`,
        taskSignal: buildTaskSignal({
          input,
          text,
          fallback: 'provider-health',
          taskKind: 'provider-health',
          recommendationReason: `provider-${providerHealthState}`,
          requiredCapabilities: taskRequiredCapabilities,
          providerHealthState,
        }),
        strategyFactors: [
          { label: 'Provider', value: formatProviderHealthState(input.providerHealth) },
          ...(metric ? [{ label: '样本', value: metric }] : []),
          ...(simpleTask ? [{ label: '任务', value: '简单问答' }] : []),
          ...(taskRequiredCapabilities.length > 0
            ? [{ label: '需要', value: formatCapabilityList(taskRequiredCapabilities) }]
            : []),
          { label: '候选', value: `${candidate.providerLabel} / ${candidate.modelLabel}` },
          { label: '候选状态', value: formatProviderHealthState(candidate.providerHealth) },
        ],
        primaryAction: 'switch-model',
        primaryLabel: '采用建议',
        targetProvider: candidate.provider,
        targetModel: candidate.model,
        targetModelLabel: candidate.modelLabel,
        targetProviderLabel: candidate.providerLabel,
      };
    }
    return {
      key: `provider-health:${taskKeySegment}:${providerLabel}:${providerHealthState}:${metric ?? 'no-metric'}`,
      tone: 'warning',
      title: providerHealthState === 'unavailable' ? '当前 provider 不可用' : '当前 provider 状态降级',
      body: `${providerLabel} 最近状态为${providerHealthState === 'unavailable' ? '不可用' : '降级'}${metric ? `（${metric}）` : ''}。这轮可能变慢或触发 fallback，建议采用自动策略或切到健康 provider。`,
      taskSignal: buildTaskSignal({
        input,
        text,
        fallback: 'provider-health',
        taskKind: 'provider-health',
        recommendationReason: `provider-${providerHealthState}`,
        requiredCapabilities: taskRequiredCapabilities,
        providerHealthState,
      }),
      strategyFactors: [
        { label: 'Provider', value: formatProviderHealthState(input.providerHealth) },
        ...(metric ? [{ label: '样本', value: metric }] : []),
        ...(simpleTask ? [{ label: '任务', value: '简单问答' }] : []),
        ...(taskRequiredCapabilities.length > 0
          ? [{ label: '需要', value: formatCapabilityList(taskRequiredCapabilities) }]
          : []),
      ],
      ...(input.adaptiveEnabled ? {} : { primaryAction: 'enable-auto' as const, primaryLabel: '采用自动' }),
    };
  }

  if (input.hasImageAttachments && !hasCapability(input.modelCapabilities, 'vision')) {
    const candidate = selectCandidate({
      candidates: input.candidates,
      currentProvider: input.currentProvider,
      currentModel: input.currentModel,
      requiredCapabilities: ['vision'],
    });
    return buildSwitchModelRecommendation({
      key: `vision:${input.modelLabel}:${buildTaskInputKey(text, 'attachment')}`,
      title: '图片任务建议视觉能力',
      body: `当前 ${input.modelLabel} 不直接读图，会先走视觉 fallback。复杂截图建议切到带视觉能力的主任务模型。`,
      candidate,
      taskSignal: buildTaskSignal({
        input,
        text,
        fallback: 'attachment',
        taskKind: 'vision',
        recommendationReason: 'missing-vision-capability',
        requiredCapabilities: ['vision'],
      }),
      strategyFactors: [{ label: '任务', value: '图片理解' }],
      requiredCapabilities: ['vision'],
    });
  }

  if (looksLikeLongContextTask(text) && !hasCapability(input.modelCapabilities, 'long-context')) {
    const candidate = selectCandidate({
      candidates: input.candidates,
      currentProvider: input.currentProvider,
      currentModel: input.currentModel,
      requiredCapabilities: ['long-context'],
    });
    return buildSwitchModelRecommendation({
      key: `long-context:${input.modelLabel}:${buildTaskInputKey(text, 'long-context')}`,
      title: '长上下文任务建议长上下文模型',
      body: `当前 ${input.modelLabel} 未标记长上下文能力。全仓、多文件或大段资料任务更适合长上下文主任务模型。`,
      candidate,
      taskSignal: buildTaskSignal({
        input,
        text,
        fallback: 'long-context',
        taskKind: 'long-context',
        recommendationReason: 'missing-long-context-capability',
        requiredCapabilities: ['long-context'],
      }),
      strategyFactors: [{ label: '任务', value: '长上下文' }],
      requiredCapabilities: ['long-context'],
    });
  }

  if (looksLikeSearchTask(text) && !hasCapability(input.modelCapabilities, 'search')) {
    const candidate = selectCandidate({
      candidates: input.candidates,
      currentProvider: input.currentProvider,
      currentModel: input.currentModel,
      requiredCapabilities: ['search'],
    });
    return buildSwitchModelRecommendation({
      key: `search:${input.modelLabel}:${buildTaskInputKey(text, 'search')}`,
      title: '联网任务建议搜索模型',
      body: `这轮看起来需要最新信息或联网检索。当前 ${input.modelLabel} 未标记搜索能力，搜索特化主任务模型更适合这类任务。`,
      candidate,
      taskSignal: buildTaskSignal({
        input,
        text,
        fallback: 'search',
        taskKind: 'search',
        recommendationReason: 'missing-search-capability',
        requiredCapabilities: ['search'],
      }),
      strategyFactors: [{ label: '任务', value: '联网检索' }],
      requiredCapabilities: ['search'],
    });
  }

  if ((looksLikeCodeTask(text) || looksLikeArtifactTask(text))
    && !hasCapability(input.modelCapabilities, 'tool')) {
    const candidate = selectCandidate({
      candidates: input.candidates,
      currentProvider: input.currentProvider,
      currentModel: input.currentModel,
      requiredCapabilities: ['tool'],
    });
    return buildSwitchModelRecommendation({
      key: `tool:${input.modelLabel}:${buildTaskInputKey(text, 'tool-task')}`,
      title: '这轮更依赖工具能力',
      body: `当前 ${input.modelLabel} 未标记工具调用能力。代码、产物或检索任务建议使用工具能力稳定的主任务模型。`,
      candidate,
      taskSignal: buildTaskSignal({
        input,
        text,
        fallback: 'tool-task',
        taskKind: 'tool',
        recommendationReason: 'missing-tool-capability',
        requiredCapabilities: ['tool'],
      }),
      strategyFactors: [{ label: '任务', value: looksLikeArtifactTask(text) ? '产物生成' : '代码任务' }],
      requiredCapabilities: ['tool'],
    });
  }

  const simpleTaskRecommendation = buildSimpleTaskRecommendation(input, text);
  if (simpleTaskRecommendation) return simpleTaskRecommendation;

  return null;
}
