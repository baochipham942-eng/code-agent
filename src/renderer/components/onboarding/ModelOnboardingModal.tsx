// ============================================================================
// ModelOnboardingModal —— 首次启动模型配置向导（连接来源 → 默认模型 两步）
//
// P3 品牌升级「抵达新栖地」欢迎时刻（拍板 2026-08-02）：欢迎内容不独立成步，
// 而是作为首步（step === 'source'）页面的上半区同屏渲染——侵入最小，不增加
// 强制步骤、不改后续步骤；进入默认模型步即自然消失，配置完成后由既有
// onboarding 触发条件保证不再出现。星球复用品牌件 PlanetSphere（地球，
// 慢转 26s/周，静态 fx），reduced-motion 由组件内建停转。
// ============================================================================

import React, { useEffect, useMemo, useState } from 'react';
import {
  ArrowLeft,
  Check,
  KeyRound,
  Loader2,
  ShieldCheck,
  Terminal,
} from 'lucide-react';
import type {
  AppSettings,
  ModelConfig,
  ModelProvider,
  ModelProviderProtocol,
} from '@shared/contract';
import type {
  AgentEngineModelCatalog,
  AgentEngineModelCatalogResult,
  AgentEngineSourceDescriptor,
  ExternalAgentEngineKind,
} from '@shared/contract/agentEngine';
import { IPC_DOMAINS } from '@shared/ipc';
import { getProviderInfo } from '@shared/constants';
import { Button, Input, Modal } from '../primitives';
import { PlanetSphere } from '../brand/PlanetSphere';
import { NeoBrandMark } from '../features/sidebar/NeoBrandMark';
import ipcService from '../../services/ipcService';
import { useI18n } from '../../hooks/useI18n';
import { useAppStore } from '../../stores/appStore';
import { useSessionStore } from '../../stores/sessionStore';
import {
  buildOnboardingModelSelection,
  getOnboardingProviderCards,
  ONBOARDING_API_COMPATIBILITY_OPTIONS,
  ONBOARDING_RELAY_CARD,
  ONBOARDING_STEPS,
  selectOnboardingDefaultModel,
  type OnboardingDiscoveredModel,
  type OnboardingRoute,
  type OnboardingStep,
} from './modelOnboarding';

interface ProviderTestResult {
  success: boolean;
  latencyMs: number;
  error?: {
    code: string;
    message: string;
    suggestion?: string;
  };
}

interface DiscoverModelsResult {
  success: boolean;
  models: OnboardingDiscoveredModel[];
  latencyMs: number;
  error?: ProviderTestResult['error'];
}

export interface ModelOnboardingModalProps {
  onComplete: (config: ModelConfig) => void;
  onSkip?: () => void;
}

type StepStatus = 'idle' | 'probing' | 'saving' | 'error';

function formatProviderError(result: ProviderTestResult | DiscoverModelsResult | undefined, fallback: string): string {
  if (!result?.error) return fallback;
  return [result.error.message, result.error.suggestion].filter(Boolean).join('。');
}

function EngineIcon({ source }: { source: AgentEngineSourceDescriptor }) {
  return (
    <span className="grid h-8 w-8 shrink-0 place-items-center overflow-hidden" data-engine-icon-slot>
      {source.iconAsset ? (
        <img src={source.iconAsset} alt="" className="h-8 w-8 object-contain" />
      ) : (
        <Terminal className="h-8 w-8 text-zinc-300" aria-hidden="true" />
      )}
    </span>
  );
}

function getOnboardingEngineStatus(source: AgentEngineSourceDescriptor): {
  detail: string;
  badge: string;
} {
  if (source.selectable) {
    return {
      detail: `${source.version || '已检测'} · Adapter 已开放 · 官方登录已确认`,
      badge: '可用',
    };
  }
  if (source.detected) {
    // 找到了客户端但探测没跑通：这是「此刻问不出来」，不是「你没装」也不是「你没登录」。
    // 说成后两者会让用户去装一个已经装好的东西、或去登一个已经登好的账号。
    if (source.probeError) {
      return { detail: '已检测到客户端 · 本机探测未完成，稍后重试', badge: '待重试' };
    }
    if (source.evidence !== 'production') {
      if (source.authState === 'needs_login') {
        return {
          detail: '已检测 · CLI 未登录 · 生产 Adapter 未开放',
          badge: '需登录',
        };
      }
      return {
        detail: source.evidence === 'local_spike'
          ? '已检测 · 已有实机 Spike · 生产 Adapter 未开放'
          : '已检测 · Adapter 尚未验证',
        badge: '待开放',
      };
    }
    if (source.authState === 'needs_login') {
      return { detail: 'Adapter 已开放 · 请先在官方客户端登录', badge: '需登录' };
    }
    return { detail: 'Adapter 已开放 · 登录状态无法安全确认', badge: '待验证' };
  }
  if (source.evidence === 'production') {
    return { detail: 'Adapter 已开放 · 本机未检测到客户端', badge: '未安装' };
  }
  if (source.evidence === 'local_spike') {
    return { detail: '已有实机 Spike · 生产 Adapter 未开放', badge: '待开放' };
  }
  return {
    detail: source.recommendation?.reason || '尚无本机协议证据',
    badge: source.recommendation?.label || '推荐安装',
  };
}

function OnboardingEngineCard({
  source,
  onSelect,
}: {
  source: AgentEngineSourceDescriptor;
  onSelect: (source: AgentEngineSourceDescriptor) => void;
}) {
  const status = getOnboardingEngineStatus(source);
  const content = (
    <>
      <EngineIcon source={source} />
      <span className="min-w-0 self-center">
        <strong className="block truncate text-sm text-zinc-100">{source.label}</strong>
        <span className="block truncate text-xs text-zinc-500">{status.detail}</span>
      </span>
      <span className={source.selectable ? 'text-[11px] text-badge-success' : 'text-[11px] text-zinc-500'}>
        {status.badge}
      </span>
    </>
  );
  const className = source.selectable
    ? 'grid grid-cols-[32px_minmax(0,1fr)_auto] items-center gap-3 rounded-lg border border-zinc-800 bg-zinc-950/30 p-3 text-left transition hover:border-blue-400/60 hover:bg-blue-500/10'
    : 'grid grid-cols-[32px_minmax(0,1fr)_auto] items-center gap-3 rounded-lg border border-zinc-800 bg-zinc-950/20 p-3 opacity-75';

  return source.selectable ? (
    <button
      type="button"
      onClick={() => onSelect(source)}
      data-onboarding-engine={source.manifestId}
      className={className}
    >
      {content}
    </button>
  ) : (
    <div
      data-onboarding-engine-status={source.manifestId}
      data-onboarding-recommendation={!source.detected ? source.manifestId : undefined}
      className={className}
    >
      {content}
    </div>
  );
}

function sourceModels(
  source: AgentEngineSourceDescriptor | null,
  catalog: AgentEngineModelCatalog | null,
): OnboardingDiscoveredModel[] {
  if (!source?.kind || source.kind === 'native' || source.modelSelection !== 'runtime_catalog') return [];
  return (catalog?.engines.find((entry) => entry.kind === source.kind)?.models ?? [])
    .filter((model) => !model.disabledReason)
    .map((model) => ({
      id: model.id,
      label: model.label,
      capabilities: model.capabilities,
    }));
}

export const ModelOnboardingModal: React.FC<ModelOnboardingModalProps> = ({ onComplete, onSkip }) => {
  const cards = useMemo(() => getOnboardingProviderCards(), []);
  const { t } = useI18n();
  const text = t.onboarding;
  const [step, setStep] = useState<OnboardingStep>('source');
  const [route, setRoute] = useState<OnboardingRoute>('subscription');
  const [engineSources, setEngineSources] = useState<AgentEngineSourceDescriptor[] | null>(null);
  const [engineCatalog, setEngineCatalog] = useState<AgentEngineModelCatalog | null>(null);
  const [selectedSource, setSelectedSource] = useState<AgentEngineSourceDescriptor | null>(null);
  const [selectedProvider, setSelectedProvider] = useState<ModelProvider>('deepseek');
  const [customProtocol, setCustomProtocol] = useState<ModelProviderProtocol>('openai');
  const [apiKey, setApiKey] = useState('');
  const [customBaseUrl, setCustomBaseUrl] = useState('');
  const [discoveredModels, setDiscoveredModels] = useState<OnboardingDiscoveredModel[]>([]);
  const [selectedModel, setSelectedModel] = useState('');
  const [status, setStatus] = useState<StepStatus>('idle');
  const [message, setMessage] = useState('');
  const currentModelConfig = useAppStore((state) => state.modelConfig);
  const appWorkingDirectory = useAppStore((state) => state.workingDirectory);
  const currentSessionId = useSessionStore((state) => state.currentSessionId);
  const currentSession = useSessionStore((state) =>
    state.currentSessionId
      ? state.sessions.find((session) => session.id === state.currentSessionId) ?? null
      : null
  );
  const updateSessionEngine = useSessionStore((state) => state.updateSessionEngine);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      ipcService.invokeDomain<AgentEngineSourceDescriptor[]>(IPC_DOMAINS.AGENT_ENGINE, 'listSources'),
      ipcService.invokeDomain<AgentEngineModelCatalogResult>(IPC_DOMAINS.AGENT_ENGINE, 'listModels'),
    ]).then(([sources, catalog]) => {
      if (cancelled) return;
      setEngineSources(Array.isArray(sources) ? sources : []);
      setEngineCatalog(catalog?.catalog ?? null);
    }).catch((error: unknown) => {
      if (cancelled) return;
      setEngineSources([]);
      setMessage(error instanceof Error ? error.message : '本机客户端探测失败');
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const selectedCompatibility = ONBOARDING_API_COMPATIBILITY_OPTIONS.find(
    (option) => option.protocol === customProtocol,
  );
  const selectedCard = selectedProvider === 'custom'
    ? {
        ...ONBOARDING_RELAY_CARD,
        name: selectedCompatibility?.label || ONBOARDING_RELAY_CARD.name,
        description: selectedCompatibility?.description || ONBOARDING_RELAY_CARD.description,
      }
    : cards.find((card) => card.id === selectedProvider);
  const isCustom = selectedProvider === 'custom';
  const endpoint = isCustom
    ? customBaseUrl.trim().replace(/\/+$/, '')
    : getProviderInfo(selectedProvider)?.endpoint || '';
  const officialClientSources = (engineSources ?? [])
    .filter((source) => source.credentialOwner === 'official_client');
  const detectedClientSources = officialClientSources.filter((source) => source.detected);
  const installClientSources = officialClientSources.filter((source) => !source.detected);
  const subscriptionModels = sourceModels(selectedSource, engineCatalog);
  const visibleModels = route === 'subscription' ? subscriptionModels : discoveredModels;
  const isBusy = status === 'probing' || status === 'saving';

  const chooseSubscriptionSource = (source: AgentEngineSourceDescriptor) => {
    if (!source.selectable || !source.kind) return;
    const models = sourceModels(source, engineCatalog);
    setSelectedSource(source);
    setSelectedModel(
      source.modelSelection === 'runtime_catalog'
        ? engineCatalog?.engines.find((entry) => entry.kind === source.kind)?.defaultModel || models[0]?.id || ''
        : '',
    );
    setMessage('');
    setStep('model');
  };

  const probeApiSource = async () => {
    const trimmedKey = apiKey.trim();
    if (!trimmedKey) {
      setStatus('error');
      setMessage(text.missingApiKey);
      return;
    }
    if (isCustom && !endpoint) {
      setStatus('error');
      setMessage(text.missingBaseUrl);
      return;
    }

    setStatus('probing');
    setMessage(text.testingConnection);
    try {
      const protocol = isCustom ? customProtocol : undefined;
      const testResult = await ipcService.invokeDomain<ProviderTestResult>(
        IPC_DOMAINS.PROVIDER,
        'test_connection',
        {
          provider: selectedProvider,
          apiKey: trimmedKey,
          baseUrl: endpoint,
          protocol,
        },
      );
      if (!testResult.success) {
        setStatus('error');
        setMessage(formatProviderError(testResult, text.connectionFailedFallback));
        return;
      }

      const discovery = await ipcService.invokeDomain<DiscoverModelsResult>(
        IPC_DOMAINS.PROVIDER,
        'discover_models',
        {
          provider: selectedProvider,
          apiKey: trimmedKey,
          baseUrl: endpoint,
          protocol,
        },
      ).catch(() => null);
      const models = discovery?.success ? discovery.models : [];
      if (isCustom && models.length === 0) {
        setStatus('error');
        setMessage(text.relayNoModels);
        return;
      }
      const fallbackModel = selectOnboardingDefaultModel(selectedProvider, models);
      const nextModels = models.length > 0
        ? models
        : [{ id: fallbackModel, label: fallbackModel }];
      setDiscoveredModels(nextModels);
      setSelectedModel(fallbackModel);
      setStatus('idle');
      setMessage('');
      setStep('model');
    } catch (error) {
      setStatus('error');
      setMessage(error instanceof Error ? error.message : text.saveFailedFallback);
    }
  };

  const completeOnboarding = async () => {
    setStatus('saving');
    setMessage('');
    try {
      if (route === 'subscription') {
        if (!selectedSource?.kind || !selectedSource.selectable) {
          throw new Error('请选择已检测且可执行的官方客户端');
        }
        const workingDirectory = currentSession?.workingDirectory ?? appWorkingDirectory ?? undefined;
        if (currentSessionId && workingDirectory) {
          await updateSessionEngine(currentSessionId, {
            kind: selectedSource.kind,
            permissionProfile: selectedSource.kind === 'native' ? 'default' : 'read_only',
            ...(selectedModel ? { model: selectedModel } : {}),
            cwd: workingDirectory,
          });
        }
        await ipcService.invokeDomain(IPC_DOMAINS.SETTINGS, 'set', {
          onboarding: {
            completedAt: Date.now(),
            defaultEngine: selectedSource.kind,
          },
          ...(selectedSource.kind !== 'native' && selectedModel ? {
            models: {
              agentEngines: {
                [selectedSource.kind as ExternalAgentEngineKind]: {
                  defaultModel: selectedModel,
                  updatedAt: Date.now(),
                },
              },
            },
          } : {}),
        } as Partial<AppSettings>);
        onComplete(currentModelConfig);
        return;
      }

      const protocol = isCustom ? customProtocol : undefined;
      const selection = buildOnboardingModelSelection({
        provider: selectedProvider,
        apiKey: apiKey.trim(),
        baseUrl: endpoint,
        protocol,
        preferredModelId: selectedModel,
        discoveredModels,
      });
      if (isCustom) {
        try {
          selection.providerSettings.displayName = new URL(endpoint).hostname;
        } catch {
          // Keep the generic label for an unusual but already validated URL.
        }
      }
      await ipcService.invokeDomain(IPC_DOMAINS.SETTINGS, 'set', {
        models: {
          default: selectedProvider,
          defaultProvider: selectedProvider,
          providers: {
            [selectedProvider]: selection.providerSettings,
          },
        },
        onboarding: {
          completedAt: Date.now(),
          defaultEngine: 'native',
        },
      } as Partial<AppSettings>);
      onComplete(selection.modelConfig);
    } catch (error) {
      setStatus('error');
      setMessage(error instanceof Error ? error.message : text.saveFailedFallback);
    }
  };

  return (
    <Modal
      isOpen
      size="full"
      title="初始化 Neo"
      closeOnBackdropClick={false}
      closeOnEsc={false}
      showCloseButton={false}
      headerIcon={(
        /* 2026-08-02 修订：头部图标从通用 Brain 换成星芒 N 品牌标——
           初始化向导是第一次亮相，必须有 Neo 自己的识别 */
        <NeoBrandMark size={34} showWordmark={false} />
      )}
      footer={(
        <div className="flex w-full items-center justify-between gap-3">
          <div className={`text-xs ${status === 'error' ? 'text-badge-danger' : 'text-zinc-500'}`}>
            {isBusy ? <Loader2 className="mr-1 inline h-3.5 w-3.5 animate-spin" /> : null}
            {message || (route === 'subscription' ? '官方登录凭证始终由对应客户端管理' : text.keyStaysLocal)}
          </div>
          <div className="flex items-center gap-2">
            {step === 'source' && onSkip ? (
              <Button variant="ghost" onClick={onSkip} disabled={isBusy}>{text.skipButton}</Button>
            ) : null}
            {step === 'model' ? (
              <Button
                variant="ghost"
                onClick={() => {
                  setStep('source');
                  setStatus('idle');
                  setMessage('');
                }}
                disabled={isBusy}
                leftIcon={<ArrowLeft className="h-4 w-4" />}
              >
                返回
              </Button>
            ) : null}
            {step === 'source' && route === 'api' ? (
              <Button
                onClick={() => void probeApiSource()}
                loading={isBusy}
                disabled={!apiKey.trim() || (isCustom && !endpoint)}
                leftIcon={<ShieldCheck className="h-4 w-4" />}
              >
                验证并选择模型
              </Button>
            ) : null}
            {step === 'model' ? (
              <Button
                data-testid="onboarding-continue-to-chat"
                onClick={() => void completeOnboarding()}
                loading={isBusy}
                disabled={route === 'subscription'
                  ? !selectedSource
                    || (selectedSource.modelSelection === 'runtime_catalog' && !selectedModel)
                  : !selectedModel}
              >
                继续开始
              </Button>
            ) : null}
          </div>
        </div>
      )}
    >
      <div className="min-h-[540px] space-y-5">
        {step === 'source' ? (
          <section
            className="flex flex-col items-center gap-3 pt-2 text-center"
            data-testid="onboarding-welcome"
          >
            <PlanetSphere
              kind="earth"
              size={76}
              spinSeconds={26}
              fx="none"
              glowColor="rgba(96,165,250,.18)"
            />
            <h2 className="text-lg font-semibold text-zinc-100">{text.welcomeTitle}</h2>
            <p className="max-w-md text-sm text-zinc-500">{text.welcomeSubtitle}</p>
          </section>
        ) : null}
        <div className="grid grid-cols-2 gap-2 text-xs text-zinc-400" data-testid="onboarding-stepper">
          {ONBOARDING_STEPS.map((id, index) => {
            const active = step === id;
            const done = ONBOARDING_STEPS.indexOf(step) > index;
            return (
              <div
                key={id}
                data-testid={`onboarding-step-${id}`}
                data-active={active ? 'true' : 'false'}
                className={`rounded-lg border px-3 py-2 ${active ? 'border-blue-400/60 bg-blue-500/10' : 'border-zinc-800 bg-zinc-950/40'}`}
              >
                <div className="flex items-center gap-2">
                  <span className="grid h-5 w-5 place-items-center rounded-full bg-zinc-800 text-[11px] text-zinc-200">
                    {done ? '✓' : index + 1}
                  </span>
                  <span className={active ? 'font-medium text-zinc-100' : 'font-medium text-zinc-300'}>
                    {id === 'source' ? '连接来源' : '默认模型'}
                  </span>
                </div>
              </div>
            );
          })}
        </div>

        {step === 'source' ? (
          <>
            <div
              className="flex border-b border-zinc-700"
              role="tablist"
              aria-label="连接来源"
              data-testid="onboarding-route-tabs"
            >
              <button
                type="button"
                onClick={() => setRoute('subscription')}
                data-testid="onboarding-route-subscription"
                role="tab"
                aria-selected={route === 'subscription'}
                aria-controls="onboarding-subscription-panel"
                className={`relative -mb-px flex-1 rounded-t-lg border px-3 py-2.5 text-sm font-medium ${
                  route === 'subscription'
                    ? 'border-blue-400/60 border-b-zinc-900 bg-zinc-900 text-zinc-100'
                    : 'border-transparent border-b-zinc-700 text-zinc-500 hover:bg-zinc-900/50 hover:text-zinc-300'
                }`}
              >
                官方账号 / 订阅
              </button>
              <button
                type="button"
                onClick={() => setRoute('api')}
                data-testid="onboarding-route-api"
                role="tab"
                aria-selected={route === 'api'}
                aria-controls="onboarding-api-panel"
                className={`relative -mb-px flex-1 rounded-t-lg border px-3 py-2.5 text-sm font-medium ${
                  route === 'api'
                    ? 'border-blue-400/60 border-b-zinc-900 bg-zinc-900 text-zinc-100'
                    : 'border-transparent border-b-zinc-700 text-zinc-500 hover:bg-zinc-900/50 hover:text-zinc-300'
                }`}
              >
                API Key
              </button>
            </div>

            {route === 'subscription' ? (
              <section
                id="onboarding-subscription-panel"
                role="tabpanel"
                className="space-y-4"
                data-testid="onboarding-subscription-sources"
              >
                <div>
                  <h3 className="text-sm font-medium text-zinc-100">选择本机已登录的官方客户端</h3>
                  <p className="mt-1 text-xs text-zinc-500">整卡点击后直接进入默认模型；未通过 Adapter 门禁的来源不会伪装成可用。</p>
                </div>
                {engineSources === null ? (
                  <div className="rounded-lg border border-zinc-800 p-6 text-center text-xs text-zinc-500">
                    <Loader2 className="mx-auto mb-2 h-4 w-4 animate-spin" />
                    正在探测本机客户端…
                  </div>
                ) : (
                  <>
                    <div>
                      <h4 className="text-xs font-medium text-zinc-300">本机已检测</h4>
                      <div className="mt-2 grid gap-2 md:grid-cols-2">
                        {detectedClientSources.map((source) => (
                          <OnboardingEngineCard
                            key={source.manifestId}
                            source={source}
                            onSelect={chooseSubscriptionSource}
                          />
                        ))}
                      </div>
                    </div>
                    {detectedClientSources.length === 0 ? (
                      <div className="rounded-lg border border-zinc-800 bg-zinc-950/30 p-5 text-center text-xs text-zinc-500">
                        未检测到本机官方客户端。
                      </div>
                    ) : null}
                    {installClientSources.length > 0 ? <div>
                      <h4 className="text-xs font-medium text-zinc-300">未安装 / 推荐项</h4>
                      <div className="mt-2 grid gap-2 md:grid-cols-2">
                        {installClientSources.map((source) => (
                          <OnboardingEngineCard
                            key={source.manifestId}
                            source={source}
                            onSelect={chooseSubscriptionSource}
                          />
                        ))}
                      </div>
                    </div> : null}
                  </>
                )}
              </section>
            ) : (
              <section
                id="onboarding-api-panel"
                role="tabpanel"
                className="space-y-4"
                data-testid="onboarding-api-source"
              >
                <div>
                  <h3 className="text-sm font-medium text-zinc-100">连接官方 API 或兼容接口</h3>
                  <p className="mt-1 text-xs text-zinc-500">先验证接口并读取真实模型目录，再进入默认模型。</p>
                </div>
                <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                  {cards.map((card) => (
                    <button
                      key={card.id}
                      type="button"
                      onClick={() => {
                        setSelectedProvider(card.id);
                        setStatus('idle');
                        setMessage('');
                      }}
                      className={`rounded-lg border px-3 py-2 text-left ${selectedProvider === card.id ? 'border-blue-400/60 bg-blue-500/10' : 'border-zinc-800 bg-zinc-950/30'}`}
                    >
                      <span className="text-sm font-medium text-zinc-100">{card.name}</span>
                      <span className="mt-0.5 block truncate text-xs text-zinc-500">{card.description}</span>
                    </button>
                  ))}
                </div>
                <div className="grid gap-2 sm:grid-cols-2">
                  {ONBOARDING_API_COMPATIBILITY_OPTIONS.map((option) => (
                    <button
                      key={option.id}
                      type="button"
                      data-api-compatibility={option.id}
                      onClick={() => {
                        setSelectedProvider('custom');
                        setCustomProtocol(option.protocol);
                        setStatus('idle');
                        setMessage('');
                      }}
                      className={`rounded-lg border p-3 text-left ${isCustom && customProtocol === option.protocol ? 'border-blue-400/60 bg-blue-500/10' : 'border-zinc-800 bg-zinc-950/30'}`}
                    >
                      <span className="text-sm font-medium text-zinc-100">{option.label}</span>
                      <span className="mt-1 block text-xs text-zinc-500">{option.description}</span>
                    </button>
                  ))}
                </div>
                <div className="grid gap-4 rounded-lg border border-zinc-800 bg-zinc-950/40 p-4 md:grid-cols-2">
                  <div>
                    <h4 className="text-sm font-medium text-zinc-200">{selectedCard?.name || selectedProvider}</h4>
                    <p className="mt-1 text-xs text-zinc-500">{selectedCard?.description}</p>
                    {isCustom ? (
                      <div className="mt-3">
                        <label className="mb-2 block text-sm text-zinc-200">{text.baseUrlLabel}</label>
                        <Input value={customBaseUrl} onChange={(event) => setCustomBaseUrl(event.target.value)} placeholder="https://example.com/v1" />
                      </div>
                    ) : (
                      <div className="mt-3 rounded border border-zinc-800 bg-zinc-900/50 px-3 py-2 font-mono text-[11px] text-zinc-500">{endpoint}</div>
                    )}
                  </div>
                  <div>
                    <label className="mb-2 block text-sm text-zinc-200">API Key</label>
                    <Input
                      type="password"
                      value={apiKey}
                      onChange={(event) => setApiKey(event.target.value)}
                      placeholder={text.apiKeyPlaceholder}
                      leftIcon={<KeyRound className="h-4 w-4" />}
                    />
                  </div>
                </div>
              </section>
            )}
          </>
        ) : (
          <section className="space-y-4" data-testid="onboarding-model-step">
            <div>
              <h3 className="text-sm font-medium text-zinc-100">确认默认模型</h3>
              <p className="mt-1 text-xs text-zinc-500">
                {route === 'subscription'
                  ? `${selectedSource?.label || '官方客户端'} 只展示探测到的真实模型能力。`
                  : `${selectedCard?.name || selectedProvider} 已通过连接验证。`}
              </p>
            </div>
            {route === 'subscription' && selectedSource?.modelSelection === 'client_default' ? (
              <button
                type="button"
                onClick={() => setSelectedModel('')}
                className="w-full rounded-lg border border-blue-400/60 bg-blue-500/10 p-4 text-left"
                data-client-default-model
              >
                <span className="flex items-center gap-2 text-sm font-medium text-zinc-100">
                  <Check className="h-4 w-4 text-blue-300" />
                  客户端默认模型
                </span>
                <span className="mt-1 block text-xs text-zinc-500">官方客户端没有返回可枚举目录，模型选择继续由客户端管理。</span>
              </button>
            ) : (
              <div className="grid gap-2 md:grid-cols-2">
                {visibleModels.map((model) => (
                  <button
                    key={model.id}
                    type="button"
                    onClick={() => setSelectedModel(model.id)}
                    data-onboarding-model={model.id}
                    className={`rounded-lg border p-3 text-left ${selectedModel === model.id ? 'border-blue-400/60 bg-blue-500/10' : 'border-zinc-800 bg-zinc-950/30'}`}
                  >
                    <span className="flex items-center gap-2 text-sm font-medium text-zinc-100">
                      {selectedModel === model.id ? <Check className="h-4 w-4 text-blue-300" /> : null}
                      {model.label}
                    </span>
                    <span className="mt-1 block text-xs text-zinc-500">{model.id}</span>
                  </button>
                ))}
              </div>
            )}
          </section>
        )}
      </div>
    </Modal>
  );
};
