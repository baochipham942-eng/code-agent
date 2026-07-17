import type { AgentEngineFailureDiagnostics, AgentEngineKind } from '@shared/contract/agentEngine';
import type { AgentEngineSessionMetadata } from '@shared/contract/agentEngine';
import type { BillingMode } from '@shared/contract/modelDecision';
import type { ModelProvider } from '@shared/contract/model';
import type { ModelDomainCapability } from '@shared/constants';
import type { Translations } from '../../../../i18n/zh';

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

export async function applyModelStrategyRecommendationAction(
  t: Translations,
  {
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
  }: ApplyModelStrategyRecommendationOptions,
): Promise<ApplyModelStrategyRecommendationResult> {
  const { apply } = t.modelStrategy;
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
      notifySuccess(apply.switchedNativeSuccess);
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
      notifyError(apply.applyFailedPrefix + (res?.error?.message ?? apply.unknownError));
      return 'failed';
    }

    applyOverride(switchPayload);
    dismiss(recommendation.key);
    const feedback = buildModelStrategyRecommendationFeedback(recommendation, 'applied');
    if (feedback) recordFeedback?.(feedback);
    if (recommendation.primaryAction === 'switch-model') {
      notifySuccess(apply.switchedModelSuccess
        .replace('{provider}', recommendation.targetProviderLabel ?? switchPayload.provider)
        .replace('{model}', recommendation.targetModelLabel ?? switchPayload.model));
      return 'switch-model';
    }

    notifySuccess(apply.autoStrategySuccess);
    return 'enable-auto';
  } catch (error) {
    const feedback = buildModelStrategyRecommendationFeedback(recommendation, 'apply-failed');
    if (feedback) recordFeedback?.(feedback);
    notifyError(apply.applyFailedPrefix + (error instanceof Error ? error.message : apply.unknownError));
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

function getEngineLabel(t: Translations, engineKind: AgentEngineKind): string {
  switch (engineKind) {
    case 'claude_code':
      return 'Claude Code';
    case 'codex_cli':
      return 'Codex CLI';
    default:
      return t.modelStrategy.currentEngineFallback;
  }
}

function formatFailureAge(t: Translations, occurredAt?: number, now = Date.now()): string {
  const { failureAge } = t.modelStrategy;
  if (typeof occurredAt !== 'number' || !Number.isFinite(occurredAt)) return failureAge.recent;
  const ageMs = Math.max(0, now - occurredAt);
  if (ageMs < 60_000) return failureAge.justNow;
  if (ageMs < 60 * 60_000) return failureAge.minutesAgo.replace('{n}', String(Math.floor(ageMs / 60_000)));
  if (ageMs < 24 * 60 * 60_000) return failureAge.hoursAgo.replace('{n}', String(Math.floor(ageMs / (60 * 60_000))));
  return failureAge.daysAgo.replace('{n}', String(Math.floor(ageMs / (24 * 60 * 60_000))));
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

function formatCapabilityList(t: Translations, capabilities: ModelDomainCapability[]): string {
  const labels = t.modelStrategy.capabilityLabels;
  return capabilities.map((capability) => labels[capability] ?? capability).join(' / ');
}

function formatProviderHealthState(t: Translations, health?: ModelStrategyProviderHealthSnapshot | null): string {
  return t.modelStrategy.providerHealthLabels[normalizeProviderHealthState(health?.status)];
}

function formatProviderHealthMetric(t: Translations, health?: ModelStrategyProviderHealthSnapshot | null): string | null {
  const parts = [
    typeof health?.latencyP50 === 'number' && Number.isFinite(health.latencyP50)
      ? `P50 ${Math.round(health.latencyP50)}ms`
      : null,
    typeof health?.errorRate === 'number' && Number.isFinite(health.errorRate)
      ? t.modelStrategy.errorRateMetric.replace('{pct}', String(Math.round(health.errorRate * 100)))
      : null,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(t.modelStrategy.metricJoiner) : null;
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

function buildSwitchModelRecommendation(t: Translations, args: {
  key: string;
  title: string;
  body: string;
  candidate: ModelStrategyCandidate | null;
  strategyFactors?: ModelStrategyRecommendationFactor[];
  requiredCapabilities?: ModelDomainCapability[];
  taskSignal?: ModelStrategyRecommendationTaskSignal;
}): ModelStrategyRecommendation {
  const { factorLabels } = t.modelStrategy;
  const strategyFactors = [
    ...(args.strategyFactors ?? []),
    ...(args.requiredCapabilities?.length
      ? [{ label: factorLabels.need, value: formatCapabilityList(t, args.requiredCapabilities) }]
      : []),
    ...(args.candidate
      ? [
        { label: factorLabels.candidate, value: `${args.candidate.providerLabel} / ${args.candidate.modelLabel}` },
        { label: factorLabels.candidateStatus, value: formatProviderHealthState(t, args.candidate.providerHealth) },
      ]
      : []),
  ];
  return {
    key: args.key,
    tone: 'warning',
    title: args.title,
    body: args.candidate
      ? args.body + t.modelStrategy.switchSuggestionSuffix.replace('{candidate}', `${args.candidate.providerLabel} / ${args.candidate.modelLabel}`)
      : args.body,
    ...(strategyFactors.length > 0 ? { strategyFactors } : {}),
    ...(args.taskSignal ? { taskSignal: args.taskSignal } : {}),
    ...(args.candidate
      ? {
        primaryAction: 'switch-model' as const,
        primaryLabel: t.modelStrategy.primaryLabelSwitch,
        targetProvider: args.candidate.provider,
        targetModel: args.candidate.model,
        targetModelLabel: args.candidate.modelLabel,
        targetProviderLabel: args.candidate.providerLabel,
      }
      : {}),
  };
}

function buildSimpleTaskRecommendation(
  t: Translations,
  input: ModelStrategyRecommendationInput,
  text: string,
): ModelStrategyRecommendation | null {
  if (!looksLikeSimpleTask(text)) return null;
  const { factorLabels, factorValues, simpleFast, simpleAuto } = t.modelStrategy;

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
    const billingCopy = billingMode === 'unknown' ? simpleFast.billingCopyUnknown : simpleFast.billingCopyDefault;
    return buildSwitchModelRecommendation(t, {
      key: `simple:fast:${billingMode}:${input.modelLabel}:${fastCandidate.provider}:${fastCandidate.model}`,
      title: simpleFast.title,
      body: simpleFast.body.replace('{model}', input.modelLabel).replace('{billingCopy}', billingCopy),
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
        { label: factorLabels.task, value: factorValues.simpleTask },
        { label: factorLabels.billing, value: billingMode === 'unknown' ? factorValues.billingUnknown : billingMode === 'plan' ? factorValues.billingPlan : factorValues.billingFree },
        { label: factorLabels.speed, value: factorValues.currentHeavy },
      ],
    });
  }

  if (input.adaptiveEnabled) return null;
  if (billingMode !== 'payg') return null;

  const heavyModelNote = modelSpeed === 'slow'
    ? simpleAuto.heavyModelNote.replace('{model}', input.modelLabel)
    : '';
  return {
    key: `simple:auto:${billingMode}:${modelSpeed}:${text}`,
    tone: 'info',
    title: modelSpeed === 'slow' ? simpleAuto.titleSlow : simpleAuto.titleDefault,
    body: simpleAuto.body.replace('{heavyModelNote}', heavyModelNote),
    taskSignal: buildTaskSignal({
      input,
      text,
      fallback: 'simple-task',
      taskKind: 'simple',
      recommendationReason: 'simple-auto-strategy',
      modelSpeed,
    }),
    strategyFactors: [
      { label: factorLabels.task, value: factorValues.simpleTask },
      { label: factorLabels.billing, value: factorValues.billingPayg },
      { label: factorLabels.speed, value: modelSpeed === 'slow' ? factorValues.currentHeavy : factorValues.standard },
    ],
    primaryAction: 'enable-auto',
    primaryLabel: t.modelStrategy.primaryLabelAuto,
  };
}

export function buildModelStrategyRecommendation(
  t: Translations,
  input: ModelStrategyRecommendationInput,
): ModelStrategyRecommendation | null {
  const { factorLabels, factorValues, externalFailure, externalAttachment, externalReadonly, providerHealth: providerHealthCopy, vision: visionCopy, longContextTask, search: searchCopy, tool: toolCopy } = t.modelStrategy;
  const text = input.inputValue.trim();
  if (!text && !input.hasImageAttachments) return null;
  const taskRequiredCapabilities = deriveTaskRequiredCapabilities(input, text);
  const simpleTask = taskRequiredCapabilities.length === 0 && looksLikeSimpleTask(text);

  if (input.engineKind !== 'native') {
    const engineLabel = getEngineLabel(t, input.engineKind);
    if (input.externalEngineFailure) {
      const failure = input.externalEngineFailure;
      const failureAge = formatFailureAge(t, failure.occurredAt);
      return {
        key: `external-failure:${input.engineKind}:${failure.reason}:${failure.occurredAt ?? 'unknown'}`,
        tone: 'warning',
        title: externalFailure.title.replace('{engine}', engineLabel),
        body: externalFailure.body
          .replace('{engine}', engineLabel)
          .replace('{failureAge}', failureAge)
          .replace('{failureLabel}', t.modelStrategy.engineFailureLabels[failure.category])
          .replace('{reason}', failure.reason)
          .replace('{suggestion}', failure.suggestion),
        taskSignal: buildTaskSignal({
          input,
          text,
          fallback: 'external-failure',
          taskKind: 'external-failure',
          recommendationReason: `${failure.category}:${failure.reason}`,
          requiredCapabilities: taskRequiredCapabilities,
        }),
        strategyFactors: [
          { label: factorLabels.engine, value: engineLabel },
          { label: factorLabels.failure, value: t.modelStrategy.engineFailureLabels[failure.category] },
          { label: factorLabels.time, value: failureAge },
          { label: factorLabels.recovery, value: failure.retryable ? factorValues.retryable : factorValues.needsAttention },
        ],
        ...(failure.retryable ? {} : {
          primaryAction: 'switch-native-engine' as const,
          primaryLabel: t.modelStrategy.switchNativeLabel,
        }),
      };
    }
    if (input.hasImageAttachments) {
      return {
        key: `external-attachments:${input.engineKind}:${buildTaskInputKey(text, 'attachment')}`,
        tone: 'warning',
        title: externalAttachment.title,
        body: externalAttachment.body.replace('{engine}', engineLabel),
        taskSignal: buildTaskSignal({
          input,
          text,
          fallback: 'attachment',
          taskKind: 'external-attachment',
          recommendationReason: 'external-engine-text-only',
          requiredCapabilities: ['vision'],
        }),
        strategyFactors: [
          { label: factorLabels.engine, value: engineLabel },
          { label: factorLabels.input, value: factorValues.imageAttachment },
          { label: factorLabels.channel, value: factorValues.textPromptChannel },
        ],
        primaryAction: 'switch-native-engine',
        primaryLabel: t.modelStrategy.switchNativeLabel,
      };
    }
    if (looksLikeCodeTask(text) || looksLikeArtifactTask(text)) {
      return {
        key: `external-readonly:${input.engineKind}:${buildTaskInputKey(text, 'write-task')}`,
        tone: 'warning',
        title: externalReadonly.title,
        body: externalReadonly.body.replace('{engine}', engineLabel),
        taskSignal: buildTaskSignal({
          input,
          text,
          fallback: 'write-task',
          taskKind: 'external-write',
          recommendationReason: 'external-engine-readonly',
          requiredCapabilities: ['tool'],
        }),
        strategyFactors: [
          { label: factorLabels.engine, value: engineLabel },
          { label: factorLabels.task, value: factorValues.codeArtifactTask },
          { label: factorLabels.channel, value: factorValues.readonlyCliChannel },
        ],
        primaryAction: 'switch-native-engine',
        primaryLabel: t.modelStrategy.switchNativeLabel,
      };
    }
    return null;
  }

  const providerHealthState = normalizeProviderHealthState(input.providerHealth?.status);
  if (providerHealthState === 'degraded' || providerHealthState === 'unavailable') {
    const providerLabel = input.providerLabel || providerHealthCopy.currentProviderFallback;
    const metric = formatProviderHealthMetric(t, input.providerHealth);
    const metricSuffix = metric ? t.modelStrategy.metricWrap.replace('{metric}', metric) : '';
    const statusLabel = providerHealthState === 'unavailable' ? providerHealthCopy.statusUnavailable : providerHealthCopy.statusDegraded;
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
        title: providerHealthState === 'unavailable' ? providerHealthCopy.titleUnavailable : providerHealthCopy.titleDegraded,
        body: providerHealthCopy.bodyWithCandidate
          .replace('{provider}', providerLabel)
          .replace('{status}', statusLabel)
          .replace('{metric}', metricSuffix)
          .replace('{candidate}', `${candidate.providerLabel} / ${candidate.modelLabel}`),
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
          { label: factorLabels.provider, value: formatProviderHealthState(t, input.providerHealth) },
          ...(metric ? [{ label: factorLabels.sample, value: metric }] : []),
          ...(simpleTask ? [{ label: factorLabels.task, value: factorValues.simpleTask }] : []),
          ...(taskRequiredCapabilities.length > 0
            ? [{ label: factorLabels.need, value: formatCapabilityList(t, taskRequiredCapabilities) }]
            : []),
          { label: factorLabels.candidate, value: `${candidate.providerLabel} / ${candidate.modelLabel}` },
          { label: factorLabels.candidateStatus, value: formatProviderHealthState(t, candidate.providerHealth) },
        ],
        primaryAction: 'switch-model',
        primaryLabel: t.modelStrategy.primaryLabelSwitch,
        targetProvider: candidate.provider,
        targetModel: candidate.model,
        targetModelLabel: candidate.modelLabel,
        targetProviderLabel: candidate.providerLabel,
      };
    }
    return {
      key: `provider-health:${taskKeySegment}:${providerLabel}:${providerHealthState}:${metric ?? 'no-metric'}`,
      tone: 'warning',
      title: providerHealthState === 'unavailable' ? providerHealthCopy.titleUnavailable : providerHealthCopy.titleDegraded,
      body: providerHealthCopy.bodyWithoutCandidate
        .replace('{provider}', providerLabel)
        .replace('{status}', statusLabel)
        .replace('{metric}', metricSuffix),
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
        { label: factorLabels.provider, value: formatProviderHealthState(t, input.providerHealth) },
        ...(metric ? [{ label: factorLabels.sample, value: metric }] : []),
        ...(simpleTask ? [{ label: factorLabels.task, value: factorValues.simpleTask }] : []),
        ...(taskRequiredCapabilities.length > 0
          ? [{ label: factorLabels.need, value: formatCapabilityList(t, taskRequiredCapabilities) }]
          : []),
      ],
      ...(input.adaptiveEnabled ? {} : { primaryAction: 'enable-auto' as const, primaryLabel: t.modelStrategy.primaryLabelAuto }),
    };
  }

  if (input.hasImageAttachments && !hasCapability(input.modelCapabilities, 'vision')) {
    const candidate = selectCandidate({
      candidates: input.candidates,
      currentProvider: input.currentProvider,
      currentModel: input.currentModel,
      requiredCapabilities: ['vision'],
    });
    return buildSwitchModelRecommendation(t, {
      key: `vision:${input.modelLabel}:${buildTaskInputKey(text, 'attachment')}`,
      title: visionCopy.title,
      body: visionCopy.body.replace('{model}', input.modelLabel),
      candidate,
      taskSignal: buildTaskSignal({
        input,
        text,
        fallback: 'attachment',
        taskKind: 'vision',
        recommendationReason: 'missing-vision-capability',
        requiredCapabilities: ['vision'],
      }),
      strategyFactors: [{ label: factorLabels.task, value: factorValues.imageUnderstanding }],
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
    return buildSwitchModelRecommendation(t, {
      key: `long-context:${input.modelLabel}:${buildTaskInputKey(text, 'long-context')}`,
      title: longContextTask.title,
      body: longContextTask.body.replace('{model}', input.modelLabel),
      candidate,
      taskSignal: buildTaskSignal({
        input,
        text,
        fallback: 'long-context',
        taskKind: 'long-context',
        recommendationReason: 'missing-long-context-capability',
        requiredCapabilities: ['long-context'],
      }),
      strategyFactors: [{ label: factorLabels.task, value: factorValues.longContext }],
      requiredCapabilities: ['long-context'],
    });
  }

  // 有工具能力的模型可通过 WebSearch 工具联网搜索（实测 MiMo 3.3s 搜完），不应误报"不擅长搜索"。
  // 仅当模型既无原生 search 能力、又无 tool 能力（真的没法搜）时才提示换模型。
  if (looksLikeSearchTask(text)
    && !hasCapability(input.modelCapabilities, 'search')
    && !hasCapability(input.modelCapabilities, 'tool')) {
    const candidate = selectCandidate({
      candidates: input.candidates,
      currentProvider: input.currentProvider,
      currentModel: input.currentModel,
      requiredCapabilities: ['search'],
    });
    return buildSwitchModelRecommendation(t, {
      key: `search:${input.modelLabel}:${buildTaskInputKey(text, 'search')}`,
      title: searchCopy.title,
      body: searchCopy.body.replace('{model}', input.modelLabel),
      candidate,
      taskSignal: buildTaskSignal({
        input,
        text,
        fallback: 'search',
        taskKind: 'search',
        recommendationReason: 'missing-search-capability',
        requiredCapabilities: ['search'],
      }),
      strategyFactors: [{ label: factorLabels.task, value: factorValues.webSearch }],
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
    return buildSwitchModelRecommendation(t, {
      key: `tool:${input.modelLabel}:${buildTaskInputKey(text, 'tool-task')}`,
      title: toolCopy.title,
      body: toolCopy.body.replace('{model}', input.modelLabel),
      candidate,
      taskSignal: buildTaskSignal({
        input,
        text,
        fallback: 'tool-task',
        taskKind: 'tool',
        recommendationReason: 'missing-tool-capability',
        requiredCapabilities: ['tool'],
      }),
      strategyFactors: [{ label: factorLabels.task, value: looksLikeArtifactTask(text) ? factorValues.artifactGeneration : factorValues.codeTask }],
      requiredCapabilities: ['tool'],
    });
  }

  const simpleTaskRecommendation = buildSimpleTaskRecommendation(t, input, text);
  if (simpleTaskRecommendation) return simpleTaskRecommendation;

  return null;
}
