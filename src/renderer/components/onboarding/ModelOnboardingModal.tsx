import React, { useMemo, useState } from 'react';
import { Brain, CalendarClock, CheckCircle, KeyRound, Loader2, MessageSquarePlus, Plug, ShieldCheck } from 'lucide-react';
import type { AppSettings, ModelConfig, ModelProvider } from '@shared/contract';
import { IPC_DOMAINS } from '@shared/ipc';
import { getProviderInfo } from '@shared/constants';
import { Button, Input, Modal } from '../primitives';
import ipcService from '../../services/ipcService';
import { useI18n } from '../../hooks/useI18n';
import { useMcpServerStates } from '../../hooks/useMcpServerStates';
import { useAppStore } from '../../stores/appStore';
import {
  buildOnboardingModelSelection,
  getOnboardingConnectorCards,
  getOnboardingProviderCards,
  ONBOARDING_RELAY_CARD,
  ONBOARDING_STEPS,
  type OnboardingDiscoveredModel,
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
  error?: {
    code: string;
    message: string;
    suggestion?: string;
  };
}

export interface ModelOnboardingModalProps {
  onComplete: (config: ModelConfig) => void;
  /** 跳过配置，稍后在设置里完成。不传则不显示跳过按钮。 */
  onSkip?: () => void;
}

type StepStatus = 'idle' | 'testing' | 'discovering' | 'saving' | 'ready' | 'error';

function formatProviderError(result: ProviderTestResult | DiscoverModelsResult | undefined, fallback: string): string {
  if (!result?.error) return fallback;
  return [result.error.message, result.error.suggestion].filter(Boolean).join('。');
}

export const ModelOnboardingModal: React.FC<ModelOnboardingModalProps> = ({ onComplete, onSkip }) => {
  const cards = useMemo(() => getOnboardingProviderCards(), []);
  const recommendedCards = cards.filter((card) => card.recommended);
  const moreCards = cards.filter((card) => !card.recommended);
  const [selectedProvider, setSelectedProvider] = useState<ModelProvider>('deepseek');
  const [apiKey, setApiKey] = useState('');
  const [customBaseUrl, setCustomBaseUrl] = useState('');
  const [status, setStatus] = useState<StepStatus>('idle');
  const { t } = useI18n();
  const text = t.onboarding;
  const [message, setMessage] = useState(text.selectProviderPrompt);
  const [discoveredCount, setDiscoveredCount] = useState<number | null>(null);
  const [step, setStep] = useState<OnboardingStep>('model');
  const [savedConfig, setSavedConfig] = useState<ModelConfig | null>(null);
  const setShowCronCenter = useAppStore((state) => state.setShowCronCenter);
  const openSettingsTab = useAppStore((state) => state.openSettingsTab);
  const mcpServerStates = useMcpServerStates();
  const connectorCards = useMemo(
    () => getOnboardingConnectorCards(new Set(
      mcpServerStates.filter((server) => server.status === 'connected').map((server) => server.config.name),
    )),
    [mcpServerStates],
  );

  const selectedCard = selectedProvider === ONBOARDING_RELAY_CARD.id
    ? ONBOARDING_RELAY_CARD
    : cards.find((card) => card.id === selectedProvider);
  const isRelay = Boolean(selectedCard?.requiresBaseUrl);
  // 中转站端点由用户填写；官方 Provider 锁定注册表端点
  const endpoint = isRelay
    ? customBaseUrl.trim().replace(/\/+$/, '')
    : getProviderInfo(selectedProvider)?.endpoint || '';
  const isBusy = status === 'testing' || status === 'discovering' || status === 'saving';

  /** 漏斗终点：把模型配置交给 App（关弹窗），需要时顺手把自动化面板打开。 */
  const finish = ({ openAutomation }: { openAutomation: boolean }) => {
    if (savedConfig) onComplete(savedConfig);
    if (openAutomation) setShowCronCenter(true);
  };

  const handleSave = async () => {
    const trimmedKey = apiKey.trim();
    if (!trimmedKey) {
      setStatus('error');
      setMessage(text.missingApiKey);
      return;
    }
    if (isRelay && !endpoint) {
      setStatus('error');
      setMessage(text.missingBaseUrl);
      return;
    }

    setStatus('testing');
    setMessage(text.testingConnection);
    setDiscoveredCount(null);

    try {
      const testResult = await ipcService.invokeDomain<ProviderTestResult>(
        IPC_DOMAINS.PROVIDER,
        'test_connection',
        { provider: selectedProvider, apiKey: trimmedKey, baseUrl: endpoint },
      );

      if (!testResult?.success) {
        setStatus('error');
        setMessage(formatProviderError(testResult, text.connectionFailedFallback));
        return;
      }

      setStatus('discovering');
      setMessage(text.connectedTestingModels.replace('{latencyMs}', String(testResult.latencyMs)));

      let discoveredModels: OnboardingDiscoveredModel[] = [];
      const discoverResult = await ipcService.invokeDomain<DiscoverModelsResult>(
        IPC_DOMAINS.PROVIDER,
        'discover_models',
        { provider: selectedProvider, apiKey: trimmedKey, baseUrl: endpoint },
      ).catch(() => null);

      if (discoverResult?.success && discoverResult.models.length > 0) {
        discoveredModels = discoverResult.models;
        setDiscoveredCount(discoverResult.models.length);
      }

      // 中转站没有内置模型目录可兜底，必须从 /models 拉到真实模型列表才能保存，
      // 否则会落一个该站不存在的占位模型 ID（custom-model），聊天必报错。
      if (isRelay && discoveredModels.length === 0) {
        setStatus('error');
        setMessage(text.relayNoModels);
        return;
      }

      setStatus('saving');
      setMessage(discoveredModels.length > 0 ? text.savingMainModel : text.savingBuiltinModel);

      const selection = buildOnboardingModelSelection({
        provider: selectedProvider,
        apiKey: trimmedKey,
        baseUrl: endpoint,
        discoveredModels,
      });

      // 中转站用域名当显示名，模型切换面板里比 "Custom Provider" 可读
      if (isRelay) {
        try {
          selection.providerSettings.displayName = new URL(endpoint).hostname;
        } catch { /* URL 异常时保留默认显示名 */ }
      }

      await ipcService.invokeDomain(IPC_DOMAINS.SETTINGS, 'set', {
        models: {
          default: selectedProvider,
          defaultProvider: selectedProvider,
          providers: {
            [selectedProvider]: selection.providerSettings,
          },
        },
      } as Partial<AppSettings>);

      setStatus('ready');
      setMessage(text.connectedSummary
        .replace('{provider}', selectedCard?.name || selectedProvider)
        .replace('{model}', selection.modelConfig.model));
      // 模型已落盘，但漏斗还没走完：接着问「你平时在哪干活」，别把人丢进空白对话。
      setSavedConfig(selection.modelConfig);
      setStep('connectors');
    } catch (error) {
      setStatus('error');
      setMessage(error instanceof Error ? error.message : text.saveFailedFallback);
    }
  };

  return (
    <Modal
      isOpen={true}
      size="full"
      title={text.modalTitle}
      closeOnBackdropClick={false}
      closeOnEsc={false}
      showCloseButton={false}
      headerIcon={
        <div className="rounded-lg bg-blue-500/10 p-2 text-blue-300">
          <Brain className="h-6 w-6" />
        </div>
      }
      footer={
        <div className="flex w-full items-center justify-between gap-3">
          <div className="text-xs text-zinc-500">{text.keyStaysLocal}</div>
          <div className="flex items-center gap-2">
            {step === 'model' && (
              <>
                {onSkip && (
                  <Button
                    variant="ghost"
                    onClick={onSkip}
                    disabled={isBusy}
                  >
                    {text.skipButton}
                  </Button>
                )}
                <Button
                  onClick={handleSave}
                  loading={isBusy}
                  disabled={!apiKey.trim() || (isRelay && !endpoint)}
                  leftIcon={status === 'ready' ? <CheckCircle className="h-4 w-4" /> : <ShieldCheck className="h-4 w-4" />}
                >
                  {text.testAndSaveButton}
                </Button>
              </>
            )}
            {step === 'connectors' && (
              <>
                <Button variant="ghost" data-testid="onboarding-connectors-skip" onClick={() => setStep('done')}>
                  {text.connectorsSkip}
                </Button>
                <Button data-testid="onboarding-connectors-next" onClick={() => setStep('done')}>
                  {text.connectorsNext}
                </Button>
              </>
            )}
          </div>
        </div>
      }
    >
      {/* 固定高度：三步切换时下方内容不跳，非程序员不会以为「点错了」 */}
      <div className="min-h-[560px] space-y-5">
        <div className="grid gap-2 text-xs text-zinc-400 sm:grid-cols-3" data-testid="onboarding-stepper">
          {ONBOARDING_STEPS.map((id, index) => {
            const title = id === 'model' ? text.stepModel : id === 'connectors' ? text.stepConnectors : text.stepDone;
            const active = id === step;
            const done = ONBOARDING_STEPS.indexOf(step) > index;
            return (
              <div
                key={id}
                data-testid={`onboarding-step-${id}`}
                data-active={active ? 'true' : 'false'}
                className={`rounded-lg border px-3 py-2 ${active ? 'border-blue-400/60 bg-blue-500/10' : 'border-zinc-800 bg-zinc-950/40'}`}
              >
                <div className="flex items-center gap-2">
                  <span className={`flex h-5 w-5 items-center justify-center rounded-full text-[11px] ${done ? 'bg-emerald-500/20 text-emerald-200' : 'bg-zinc-800 text-zinc-200'}`}>
                    {done ? '✓' : index + 1}
                  </span>
                  <span className={`font-medium ${active ? 'text-zinc-100' : 'text-zinc-300'}`}>{title}</span>
                </div>
              </div>
            );
          })}
        </div>

        {step === 'model' && (<>
        <div className="rounded-lg border border-zinc-800 bg-zinc-950/40 p-4">
          <div className="flex items-start gap-3">
            <KeyRound className="mt-0.5 h-4 w-4 shrink-0 text-blue-300" />
            <div>
              <p className="text-sm text-zinc-200">{text.introTitle}</p>
              <p className="mt-1 text-xs leading-relaxed text-zinc-500">
                {text.introDescription}
              </p>
            </div>
          </div>
        </div>

        <section className="space-y-3">
          <div>
            <h3 className="text-sm font-medium text-zinc-200">{text.recommendedTitle}</h3>
            <p className="mt-1 text-xs text-zinc-500">{text.recommendedDescription}</p>
          </div>
          <div className="grid gap-2 md:grid-cols-2">
            {recommendedCards.map((card) => (
              <button
                key={card.id}
                type="button"
                onClick={() => {
                  setSelectedProvider(card.id);
                  setStatus('idle');
                  setMessage(text.selectProviderPrompt);
                }}
                className={`rounded-lg border p-3 text-left transition ${
                  selectedProvider === card.id
                    ? 'border-blue-400/60 bg-blue-500/10'
                    : 'border-zinc-800 bg-zinc-950/30 hover:border-zinc-700 hover:bg-zinc-900/70'
                }`}
              >
                <div className="flex items-center justify-between gap-3">
                  <span className="text-sm font-medium text-zinc-100">{card.name}</span>
                  {card.badge && (
                    <span className="rounded border border-blue-400/30 bg-blue-500/10 px-1.5 py-0.5 text-[11px] text-blue-200">
                      {card.badge}
                    </span>
                  )}
                </div>
                <p className="mt-1 text-xs leading-relaxed text-zinc-500">{card.description}</p>
              </button>
            ))}
          </div>
        </section>

        <section className="space-y-3">
          <h3 className="text-sm font-medium text-zinc-200">{text.moreProvidersTitle}</h3>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {moreCards.map((card) => (
              <button
                key={card.id}
                type="button"
                onClick={() => {
                  setSelectedProvider(card.id);
                  setStatus('idle');
                  setMessage(text.selectProviderPrompt);
                }}
                className={`rounded-lg border px-3 py-2 text-left transition ${
                  selectedProvider === card.id
                    ? 'border-blue-400/60 bg-blue-500/10'
                    : 'border-zinc-800 bg-zinc-950/30 hover:border-zinc-700 hover:bg-zinc-900/70'
                }`}
              >
                <div className="truncate text-sm font-medium text-zinc-100">{card.name}</div>
                <div className="mt-0.5 truncate text-xs text-zinc-500">{card.description}</div>
              </button>
            ))}
          </div>
        </section>

        <section className="space-y-3">
          <h3 className="text-sm font-medium text-zinc-200">{text.relaySectionTitle}</h3>
          <button
            type="button"
            onClick={() => {
              setSelectedProvider(ONBOARDING_RELAY_CARD.id);
              setStatus('idle');
              setMessage(text.relaySelectPrompt);
            }}
            className={`w-full rounded-lg border p-3 text-left transition ${
              selectedProvider === ONBOARDING_RELAY_CARD.id
                ? 'border-blue-400/60 bg-blue-500/10'
                : 'border-zinc-800 bg-zinc-950/30 hover:border-zinc-700 hover:bg-zinc-900/70'
            }`}
          >
            <div className="flex items-center justify-between gap-3">
              <span className="text-sm font-medium text-zinc-100">{ONBOARDING_RELAY_CARD.name}</span>
              <span className="rounded border border-blue-400/30 bg-blue-500/10 px-1.5 py-0.5 text-[11px] text-blue-200">
                {ONBOARDING_RELAY_CARD.badge}
              </span>
            </div>
            <p className="mt-1 text-xs leading-relaxed text-zinc-500">{ONBOARDING_RELAY_CARD.description}</p>
          </button>
        </section>

        <section className="grid gap-4 rounded-lg border border-zinc-800 bg-zinc-950/40 p-4 md:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
          <div>
            <h3 className="text-sm font-medium text-zinc-200">{selectedCard?.name || selectedProvider}</h3>
            <p className="mt-1 text-xs leading-relaxed text-zinc-500">{selectedCard?.description}</p>
            {isRelay ? (
              <div className="mt-3">
                <label className="mb-2 block text-sm font-medium text-zinc-200">{text.baseUrlLabel}</label>
                <Input
                  value={customBaseUrl}
                  onChange={(event) => {
                    setCustomBaseUrl(event.target.value);
                    if (status === 'error') {
                      setStatus('idle');
                      setMessage(text.relaySelectPrompt);
                    }
                  }}
                  placeholder="https://example.com/v1"
                />
                <p className="mt-2 text-[11px] leading-relaxed text-zinc-500">
                  {text.baseUrlHint}
                </p>
              </div>
            ) : (
              <div className="mt-3 rounded border border-zinc-800 bg-zinc-900/50 px-3 py-2 font-mono text-[11px] text-zinc-500">
                {endpoint}
              </div>
            )}
          </div>
          <div>
            <label className="mb-2 block text-sm font-medium text-zinc-200">API Key</label>
            <Input
              type="password"
              value={apiKey}
              onChange={(event) => {
                setApiKey(event.target.value);
                if (status === 'error') {
                  setStatus('idle');
                  setMessage(text.selectProviderPrompt);
                }
              }}
              placeholder={text.apiKeyPlaceholder}
              leftIcon={<KeyRound className="h-4 w-4" />}
            />
            <div className={`mt-2 flex items-center gap-2 text-xs ${
              status === 'error'
                ? 'text-red-300'
                : status === 'ready'
                  ? 'text-emerald-300'
                  : 'text-zinc-500'
            }`}
            >
              {isBusy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              <span>{message}</span>
              {discoveredCount !== null && status !== 'error' && (
                <span className="text-zinc-500">{text.discoveredModelsCount.replace('{count}', String(discoveredCount))}</span>
              )}
            </div>
          </div>
        </section>
        </>)}

        {step === 'connectors' && (
          <section className="space-y-3" data-testid="onboarding-connectors">
            <div>
              <h3 className="text-sm font-medium text-zinc-200">{text.connectorsTitle}</h3>
              <p className="mt-1 text-xs leading-relaxed text-zinc-500">{text.connectorsDescription}</p>
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              {connectorCards.map((card) => (
                <div
                  key={card.id}
                  data-testid={`onboarding-connector-${card.id}`}
                  data-connected={card.connected ? 'true' : 'false'}
                  className="rounded-lg border border-zinc-800 bg-zinc-950/30 p-3"
                >
                  <div className="flex items-center justify-between gap-3">
                    <span className="flex items-center gap-2 text-sm font-medium text-zinc-100">
                      <Plug className="h-4 w-4 text-zinc-400" />
                      {card.name}
                    </span>
                    {card.connected ? (
                      <span className="rounded border border-emerald-400/30 bg-emerald-500/10 px-1.5 py-0.5 text-[11px] text-emerald-200">
                        {text.connectorConnected}
                      </span>
                    ) : (
                      <Button size="sm" variant="secondary" onClick={() => openSettingsTab('mcp')}>
                        {text.connectorConnect}
                      </Button>
                    )}
                  </div>
                  <p className="mt-1 text-xs leading-relaxed text-zinc-500">{card.description}</p>
                </div>
              ))}
            </div>
          </section>
        )}

        {step === 'done' && (
          <section className="space-y-4" data-testid="onboarding-done">
            <div>
              <h3 className="text-sm font-medium text-zinc-200">{text.doneTitle}</h3>
              <p className="mt-1 text-xs leading-relaxed text-zinc-500">{text.doneDescription}</p>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <button /* ds-allow:button: 完成页的两张大号 CTA 卡，Button primitive 撑不出这个形态 */
                type="button"
                data-testid="onboarding-cta-automation"
                onClick={() => finish({ openAutomation: true })}
                className="rounded-lg border border-zinc-800 bg-zinc-950/30 p-4 text-left transition hover:border-blue-400/60 hover:bg-blue-500/10"
              >
                <span className="flex items-center gap-2 text-sm font-medium text-zinc-100">
                  <CalendarClock className="h-4 w-4 text-blue-300" />
                  {text.doneAutomationCta}
                </span>
                <p className="mt-1 text-xs leading-relaxed text-zinc-500">{text.doneAutomationHint}</p>
              </button>
              <button /* ds-allow:button: 同上，与左侧 CTA 对称 */
                type="button"
                data-testid="onboarding-cta-start"
                onClick={() => finish({ openAutomation: false })}
                className="rounded-lg border border-zinc-800 bg-zinc-950/30 p-4 text-left transition hover:border-blue-400/60 hover:bg-blue-500/10"
              >
                <span className="flex items-center gap-2 text-sm font-medium text-zinc-100">
                  <MessageSquarePlus className="h-4 w-4 text-emerald-300" />
                  {text.doneStartCta}
                </span>
                <p className="mt-1 text-xs leading-relaxed text-zinc-500">{text.doneStartHint}</p>
              </button>
            </div>
          </section>
        )}
      </div>
    </Modal>
  );
};
