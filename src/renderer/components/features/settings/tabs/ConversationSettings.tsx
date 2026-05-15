// ============================================================================
// ConversationSettings — 对话相关全局设置 tab
// ============================================================================
// B+ IA 调整：Routing / Browser 这种"配一次跑一年"的设置从 ChatInput 工具栏
// 移除，归到 Settings 这里。每个用户在第一次需要时配一次，后面默认值就走。
// Live Preview 已挪到 TitleBar 顶栏（跟工作目录绑定）。

import React, { useEffect, useMemo, useState } from 'react';
import { CheckCircle2, FileCheck2, GitBranch, Info, RotateCcw, SlidersHorizontal } from 'lucide-react';
import { IPC_CHANNELS } from '@shared/ipc';
import type { ConversationRoutingMode } from '@shared/contract/conversationEnvelope';
import type {
  ContextCompressionChannelState,
  ContextCompressionConfigPatch,
} from '@shared/contract/contextHealth';
import { PROVIDER_MODELS } from '@shared/constants/models';
import { useComposerStore } from '../../../../stores/composerStore';
import ipcService from '../../../../services/ipcService';
import { toast } from '../../../../hooks/useToast';
import { SettingsPage, SettingsSection } from '../SettingsLayout';

const ROUTING_OPTIONS: Array<{ value: ConversationRoutingMode; label: string; hint: string }> = [
  { value: 'auto', label: 'Auto', hint: '路由器按任务复杂度自动选模型（默认）' },
  { value: 'direct', label: 'Direct', hint: '直接用当前选中的模型，不走路由' },
  { value: 'parallel', label: 'Parallel', hint: '并行调多个模型，交叉验证产物' },
];

const DEFAULT_COMPRESSION_STATE: ContextCompressionChannelState = {
  config: {
    enabled: true,
    warningThreshold: 0.75,
    criticalThreshold: 0.85,
    preserveRecentCount: 10,
    triggerTokens: 100000,
    compactProvider: 'moonshot',
    compactModel: 'kimi-k2.5',
    auditEnabled: true,
  },
  runtime: {
    compressionCount: 0,
    totalSavedTokens: 0,
    recentStrategies: [],
  },
  compactModel: {
    provider: 'moonshot',
    model: 'kimi-k2.5',
    configured: false,
  },
  features: {
    audit: 'enabled',
    manifest: 'enabled',
    hooks: 'available',
  },
};

function percentLabel(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function tokensLabel(value?: number): string {
  if (!value) return '未设置';
  if (value >= 1000) return `${Math.round(value / 1000)}K`;
  return `${value}`;
}

function featureLabel(value: 'enabled' | 'disabled' | 'available'): string {
  if (value === 'disabled') return '关闭';
  if (value === 'available') return '可用';
  return '开启';
}

export const ConversationSettings: React.FC = () => {
  const routingMode = useComposerStore((s) => s.routingMode);
  const setRoutingMode = useComposerStore((s) => s.setRoutingMode);
  const [compressionState, setCompressionState] = useState<ContextCompressionChannelState>(DEFAULT_COMPRESSION_STATE);
  const [compressionLoading, setCompressionLoading] = useState(true);
  const [savingCompression, setSavingCompression] = useState(false);

  const providerOptions = useMemo(() => PROVIDER_MODELS, []);
  const selectedProvider = providerOptions.find(
    (provider) => provider.id === compressionState.config.compactProvider,
  ) ?? providerOptions.find((provider) => provider.id === 'moonshot') ?? providerOptions[0];
  const modelOptions = selectedProvider?.models ?? [];

  useEffect(() => {
    let cancelled = false;
    async function loadCompressionConfig() {
      try {
        const state = await ipcService.invoke(IPC_CHANNELS.CONTEXT_COMPRESSION_CONFIG_GET);
        if (!cancelled && state) {
          setCompressionState(state);
        }
      } catch (error) {
        toast.error(`加载上下文整理设置失败: ${error instanceof Error ? error.message : '未知错误'}`);
      } finally {
        if (!cancelled) setCompressionLoading(false);
      }
    }
    loadCompressionConfig();
    return () => {
      cancelled = true;
    };
  }, []);

  const updateCompression = async (patch: ContextCompressionConfigPatch) => {
    const optimisticState: ContextCompressionChannelState = {
      ...compressionState,
      config: {
        ...compressionState.config,
        ...patch,
      },
    };
    setCompressionState(optimisticState);
    setSavingCompression(true);
    try {
      const nextState = await ipcService.invoke(IPC_CHANNELS.CONTEXT_COMPRESSION_CONFIG_SET, patch);
      if (nextState) setCompressionState(nextState);
    } catch (error) {
      setCompressionState(compressionState);
      toast.error(`保存上下文整理设置失败: ${error instanceof Error ? error.message : '未知错误'}`);
    } finally {
      setSavingCompression(false);
    }
  };

  return (
    <SettingsPage
      title="对话"
      description="配置会话默认的模型路由、浏览器工具和长对话整理方式。"
    >
      <SettingsSection title="Routing" description="模型路由策略，决定每条消息怎么被分发给后端模型。">
        <div className="flex items-center gap-2 mb-3">
          <GitBranch className="w-4 h-4 text-zinc-400" />
          <span className="text-xs text-zinc-500">配一次后默认沿用</span>
        </div>
        <div className="grid grid-cols-3 gap-2">
          {ROUTING_OPTIONS.map((opt) => {
            const selected = routingMode === opt.value;
            return (
              <button
                key={opt.value}
                type="button"
                onClick={() => setRoutingMode(opt.value)}
                className={`flex flex-col items-start gap-1 px-3 py-2 rounded-lg border transition-colors text-left ${
                  selected
                    ? 'border-primary-500/40 bg-primary-500/15 text-primary-200'
                    : 'border-white/[0.08] bg-white/[0.02] text-zinc-300 hover:border-white/[0.16] hover:bg-white/[0.04]'
                }`}
              >
                <span className="text-sm font-medium">{opt.label}</span>
                <span className="text-[11px] text-zinc-500 leading-relaxed">{opt.hint}</span>
              </button>
            );
          })}
        </div>
      </SettingsSection>

      <SettingsSection title="上下文整理" description="长对话接近上限时，自动把旧内容整理成可追溯摘要，保留最近对话继续工作。">
        {compressionLoading ? (
          <div className="text-xs text-zinc-500">加载中...</div>
        ) : (
          <div className="space-y-4">
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <SlidersHorizontal className="w-4 h-4 text-zinc-400" />
                <div>
                  <div className="text-sm font-medium text-zinc-200">自动整理长对话</div>
                  <div className="text-xs text-zinc-500 mt-0.5">
                    {compressionState.config.enabled ? '开启后会在上下文变满前整理旧内容' : '关闭后只保留手动压缩入口'}
                  </div>
                </div>
              </div>
              <button
                type="button"
                onClick={() => updateCompression({ enabled: !compressionState.config.enabled })}
                className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                  compressionState.config.enabled ? 'bg-primary-500' : 'bg-zinc-700'
                }`}
                aria-pressed={compressionState.config.enabled}
              >
                <span
                  className={`inline-block h-5 w-5 transform rounded-full bg-white transition-transform ${
                    compressionState.config.enabled ? 'translate-x-5' : 'translate-x-0.5'
                  }`}
                />
              </button>
            </div>

            <div className="grid grid-cols-3 gap-2">
              <div className="rounded-lg border border-white/[0.08] bg-white/[0.02] p-3">
                <div className="text-[11px] text-zinc-500">最近保留</div>
                <div className="mt-1 flex items-center gap-2">
                  <input
                    type="number"
                    min={2}
                    max={50}
                    value={compressionState.config.preserveRecentCount}
                    onChange={(event) => updateCompression({ preserveRecentCount: Number(event.target.value) })}
                    className="w-16 rounded-md border border-white/[0.08] bg-zinc-900 px-2 py-1 text-sm text-zinc-200 outline-none focus:border-primary-500/60"
                  />
                  <span className="text-xs text-zinc-500">条消息</span>
                </div>
              </div>

              <div className="rounded-lg border border-white/[0.08] bg-white/[0.02] p-3">
                <div className="flex items-center justify-between text-[11px] text-zinc-500">
                  <span>开始提醒</span>
                  <span>{percentLabel(compressionState.config.warningThreshold)}</span>
                </div>
                <input
                  type="range"
                  min={50}
                  max={90}
                  step={5}
                  value={Math.round(compressionState.config.warningThreshold * 100)}
                  onChange={(event) => updateCompression({ warningThreshold: Number(event.target.value) / 100 })}
                  className="mt-2 w-full accent-primary-500"
                />
              </div>

              <div className="rounded-lg border border-white/[0.08] bg-white/[0.02] p-3">
                <div className="flex items-center justify-between text-[11px] text-zinc-500">
                  <span>主动整理</span>
                  <span>{percentLabel(compressionState.config.criticalThreshold)}</span>
                </div>
                <input
                  type="range"
                  min={60}
                  max={95}
                  step={5}
                  value={Math.round(compressionState.config.criticalThreshold * 100)}
                  onChange={(event) => updateCompression({ criticalThreshold: Number(event.target.value) / 100 })}
                  className="mt-2 w-full accent-primary-500"
                />
              </div>
            </div>

            <div className="grid grid-cols-3 gap-2">
              <label className="rounded-lg border border-white/[0.08] bg-white/[0.02] p-3">
                <span className="text-[11px] text-zinc-500">摘要服务</span>
                <select
                  value={compressionState.config.compactProvider}
                  onChange={(event) => {
                    const provider = providerOptions.find((item) => item.id === event.target.value);
                    updateCompression({
                      compactProvider: provider?.id,
                      compactModel: provider?.models[0]?.id,
                    });
                  }}
                  className="mt-2 w-full rounded-md border border-white/[0.08] bg-zinc-900 px-2 py-1 text-sm text-zinc-200 outline-none focus:border-primary-500/60"
                >
                  {providerOptions.map((provider) => (
                    <option key={provider.id} value={provider.id}>
                      {provider.name}
                    </option>
                  ))}
                </select>
              </label>

              <label className="rounded-lg border border-white/[0.08] bg-white/[0.02] p-3">
                <span className="text-[11px] text-zinc-500">摘要模型</span>
                <select
                  value={compressionState.config.compactModel}
                  onChange={(event) => updateCompression({ compactModel: event.target.value })}
                  className="mt-2 w-full rounded-md border border-white/[0.08] bg-zinc-900 px-2 py-1 text-sm text-zinc-200 outline-none focus:border-primary-500/60"
                >
                  {modelOptions.map((model) => (
                    <option key={model.id} value={model.id}>
                      {model.label}
                    </option>
                  ))}
                </select>
              </label>

              <label className="rounded-lg border border-white/[0.08] bg-white/[0.02] p-3">
                <span className="text-[11px] text-zinc-500">强制整理点</span>
                <div className="mt-2 flex items-center gap-2">
                  <input
                    type="number"
                    min={16}
                    max={1000}
                    value={Math.round((compressionState.config.triggerTokens ?? 100000) / 1000)}
                    onChange={(event) => updateCompression({ triggerTokens: Number(event.target.value) * 1000 })}
                    className="w-20 rounded-md border border-white/[0.08] bg-zinc-900 px-2 py-1 text-sm text-zinc-200 outline-none focus:border-primary-500/60"
                  />
                  <span className="text-xs text-zinc-500">K tokens</span>
                </div>
              </label>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => updateCompression({ auditEnabled: !compressionState.config.auditEnabled })}
                className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs transition-colors ${
                  compressionState.config.auditEnabled
                    ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
                    : 'border-white/[0.08] bg-white/[0.02] text-zinc-400'
                }`}
              >
                <FileCheck2 className="w-3.5 h-3.5" />
                整理留痕 {featureLabel(compressionState.features.audit)}
              </button>
              <span className="inline-flex items-center gap-1.5 rounded-md border border-emerald-500/30 bg-emerald-500/10 px-2 py-1 text-xs text-emerald-300">
                <CheckCircle2 className="w-3.5 h-3.5" />
                保留清单 {featureLabel(compressionState.features.manifest)}
              </span>
              <span className="inline-flex items-center gap-1.5 rounded-md border border-sky-500/30 bg-sky-500/10 px-2 py-1 text-xs text-sky-300">
                <RotateCcw className="w-3.5 h-3.5" />
                压缩前后动作 {featureLabel(compressionState.features.hooks)}
              </span>
              <span className="text-[11px] text-zinc-500">
                模型: {compressionState.compactModel.provider || compressionState.config.compactProvider}/{compressionState.compactModel.model || compressionState.config.compactModel}
                {' · '}
                已整理 {compressionState.runtime.compressionCount} 次
                {' · '}
                释放 {tokensLabel(compressionState.runtime.totalSavedTokens)} tokens
              </span>
              {savingCompression && <span className="text-[11px] text-zinc-500">保存中...</span>}
            </div>
          </div>
        )}
      </SettingsSection>

      <div className="flex items-start gap-2 px-3 py-2 rounded-lg bg-zinc-800/40 border border-white/[0.06]">
        <Info className="w-3.5 h-3.5 text-zinc-500 flex-shrink-0 mt-0.5" />
        <p className="text-[11px] text-zinc-500 leading-relaxed">
          路由策略和上下文整理是会话级配置，多数人配一次后无需再调。Browser 模式已迁移到「工作区」tab，
          运行状态依旧在顶栏和任务面板呈现。
        </p>
      </div>
    </SettingsPage>
  );
};
