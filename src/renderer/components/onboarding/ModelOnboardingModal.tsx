import React, { useMemo, useState } from 'react';
import { Brain, CheckCircle, KeyRound, Loader2, ShieldCheck } from 'lucide-react';
import type { AppSettings, ModelConfig, ModelProvider } from '@shared/contract';
import { IPC_DOMAINS } from '@shared/ipc';
import { getProviderInfo } from '@shared/constants';
import { Button, Input, Modal } from '../primitives';
import ipcService from '../../services/ipcService';
import {
  buildOnboardingModelSelection,
  getOnboardingProviderCards,
  type OnboardingDiscoveredModel,
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
}

type StepStatus = 'idle' | 'testing' | 'discovering' | 'saving' | 'ready' | 'error';

function formatProviderError(result: ProviderTestResult | DiscoverModelsResult | undefined, fallback: string): string {
  if (!result?.error) return fallback;
  return [result.error.message, result.error.suggestion].filter(Boolean).join('。');
}

export const ModelOnboardingModal: React.FC<ModelOnboardingModalProps> = ({ onComplete }) => {
  const cards = useMemo(() => getOnboardingProviderCards(), []);
  const recommendedCards = cards.filter((card) => card.recommended);
  const moreCards = cards.filter((card) => !card.recommended);
  const [selectedProvider, setSelectedProvider] = useState<ModelProvider>('deepseek');
  const [apiKey, setApiKey] = useState('');
  const [status, setStatus] = useState<StepStatus>('idle');
  const [message, setMessage] = useState('选择 Provider 后填写 API Key。');
  const [discoveredCount, setDiscoveredCount] = useState<number | null>(null);

  const selectedCard = cards.find((card) => card.id === selectedProvider);
  const endpoint = getProviderInfo(selectedProvider)?.endpoint || '';
  const isBusy = status === 'testing' || status === 'discovering' || status === 'saving';

  const handleSave = async () => {
    const trimmedKey = apiKey.trim();
    if (!trimmedKey) {
      setStatus('error');
      setMessage('请先填写 API Key。');
      return;
    }

    setStatus('testing');
    setMessage('正在测试连接...');
    setDiscoveredCount(null);

    try {
      const testResult = await ipcService.invokeDomain<ProviderTestResult>(
        IPC_DOMAINS.PROVIDER,
        'test_connection',
        { provider: selectedProvider, apiKey: trimmedKey, baseUrl: endpoint },
      );

      if (!testResult?.success) {
        setStatus('error');
        setMessage(formatProviderError(testResult, '连接失败，请检查 API Key 和网络。'));
        return;
      }

      setStatus('discovering');
      setMessage(`连接成功，延迟 ${testResult.latencyMs}ms，正在读取可用模型...`);

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

      setStatus('saving');
      setMessage(discoveredModels.length > 0 ? '正在保存默认模型...' : '正在保存内置推荐模型...');

      const selection = buildOnboardingModelSelection({
        provider: selectedProvider,
        apiKey: trimmedKey,
        baseUrl: endpoint,
        discoveredModels,
      });

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
      setMessage(`已连接 ${selectedCard?.name || selectedProvider} / ${selection.modelConfig.model}。`);
      onComplete(selection.modelConfig);
    } catch (error) {
      setStatus('error');
      setMessage(error instanceof Error ? error.message : '保存失败，请稍后重试。');
    }
  };

  return (
    <Modal
      isOpen={true}
      size="full"
      title="连接模型"
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
          <div className="text-xs text-zinc-500">
            API Key 只保存在本机安全存储里。
          </div>
          <Button
            onClick={handleSave}
            loading={isBusy}
            disabled={!apiKey.trim()}
            leftIcon={status === 'ready' ? <CheckCircle className="h-4 w-4" /> : <ShieldCheck className="h-4 w-4" />}
          >
            测试并保存
          </Button>
        </div>
      }
    >
      <div className="space-y-5">
        <div className="grid gap-2 text-xs text-zinc-400 sm:grid-cols-3">
          {[
            ['1', '注册', '已完成'],
            ['2', '配置模型', '当前步骤'],
            ['3', '进入聊天区', '保存后自动前往'],
          ].map(([index, title, caption]) => (
            <div key={index} className="rounded-lg border border-zinc-800 bg-zinc-950/40 px-3 py-2">
              <div className="flex items-center gap-2">
                <span className="flex h-5 w-5 items-center justify-center rounded-full bg-zinc-800 text-[11px] text-zinc-200">
                  {index}
                </span>
                <span className="font-medium text-zinc-200">{title}</span>
              </div>
              <div className="mt-1 text-[11px] text-zinc-500">{caption}</div>
            </div>
          ))}
        </div>

        <div className="rounded-lg border border-zinc-800 bg-zinc-950/40 p-4">
          <div className="flex items-start gap-3">
            <KeyRound className="mt-0.5 h-4 w-4 shrink-0 text-blue-300" />
            <div>
              <p className="text-sm text-zinc-200">账号已就绪，还需要连接一个模型才能开始对话。</p>
              <p className="mt-1 text-xs leading-relaxed text-zinc-500">
                这里只放官方直连 Provider。高级中转、本地模型和自定义地址仍在设置里管理。
              </p>
            </div>
          </div>
        </div>

        <section className="space-y-3">
          <div>
            <h3 className="text-sm font-medium text-zinc-200">推荐配置</h3>
            <p className="mt-1 text-xs text-zinc-500">大多数新用户从这里选一个就够了。</p>
          </div>
          <div className="grid gap-2 md:grid-cols-2">
            {recommendedCards.map((card) => (
              <button
                key={card.id}
                type="button"
                onClick={() => {
                  setSelectedProvider(card.id);
                  setStatus('idle');
                  setMessage('选择 Provider 后填写 API Key。');
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
          <h3 className="text-sm font-medium text-zinc-200">更多官方 Provider</h3>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {moreCards.map((card) => (
              <button
                key={card.id}
                type="button"
                onClick={() => {
                  setSelectedProvider(card.id);
                  setStatus('idle');
                  setMessage('选择 Provider 后填写 API Key。');
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

        <section className="grid gap-4 rounded-lg border border-zinc-800 bg-zinc-950/40 p-4 md:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
          <div>
            <h3 className="text-sm font-medium text-zinc-200">{selectedCard?.name || selectedProvider}</h3>
            <p className="mt-1 text-xs leading-relaxed text-zinc-500">{selectedCard?.description}</p>
            <div className="mt-3 rounded border border-zinc-800 bg-zinc-900/50 px-3 py-2 font-mono text-[11px] text-zinc-500">
              {endpoint}
            </div>
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
                  setMessage('选择 Provider 后填写 API Key。');
                }
              }}
              placeholder="粘贴该 Provider 的 API Key"
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
                <span className="text-zinc-500">已发现 {discoveredCount} 个模型</span>
              )}
            </div>
          </div>
        </section>
      </div>
    </Modal>
  );
};
