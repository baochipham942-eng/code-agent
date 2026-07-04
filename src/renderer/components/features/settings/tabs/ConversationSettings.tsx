// ============================================================================
// ConversationSettings — 对话相关全局设置 tab
// ============================================================================
// P1 IA 收敛：
//   1. Routing 策略 — 保留
//   2. 自动整理开关 — 第一层
//   3. 摘要模型 — 只读引用 + 跳转到模型设置（在 model tab 真正配置）
//   4. 上下文整理阈值（preserve / warning / critical / triggerTokens / audit）
//      下沉到 SettingsDetails 折叠区
// Browser 模式已在 Step 1 迁移到工作区 tab。
// ============================================================================

import React, { useEffect, useMemo, useState } from 'react';
import { ArrowUpRight, CheckCircle2, FileCheck2, Info, RotateCcw, SlidersHorizontal } from 'lucide-react';
import { IPC_CHANNELS } from '@shared/ipc';
import type {
  ContextCompressionChannelState,
  ContextCompressionConfigPatch,
} from '@shared/contract/contextHealth';
import { PROVIDER_MODELS } from '@shared/constants/models';
import { useAppStore } from '../../../../stores/appStore';
import ipcService from '../../../../services/ipcService';
import { toast } from '../../../../hooks/useToast';
import { useI18n } from '../../../../hooks/useI18n';
import { SettingsDetails, SettingsPage, SettingsSection } from '../SettingsLayout';
import { zh } from '../../../../i18n/zh';

type ConversationSettingsText = typeof zh.settings.conversation;

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

function tokensLabel(value: number | undefined, unsetLabel: string): string {
  if (!value) return unsetLabel;
  if (value >= 1000) return `${Math.round(value / 1000)}K`;
  return `${value}`;
}

function featureLabel(
  value: 'enabled' | 'disabled' | 'available',
  labels: ConversationSettingsText['featureStates'],
): string {
  if (value === 'disabled') return labels.disabled;
  if (value === 'available') return labels.available;
  return labels.enabled;
}

function getErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

export const ConversationSettings: React.FC = () => {
  const { t } = useI18n();
  const conversationText = t.settings.conversation;
  const openSettingsTab = useAppStore((s) => s.openSettingsTab);
  const [compressionState, setCompressionState] = useState<ContextCompressionChannelState>(DEFAULT_COMPRESSION_STATE);
  const [compressionLoading, setCompressionLoading] = useState(true);
  const [savingCompression, setSavingCompression] = useState(false);

  const providerOptions = useMemo(() => PROVIDER_MODELS, []);
  const selectedProvider = providerOptions.find(
    (provider) => provider.id === compressionState.config.compactProvider,
  ) ?? providerOptions.find((provider) => provider.id === 'moonshot') ?? providerOptions[0];
  const selectedModelLabel = useMemo(() => {
    const modelId = compressionState.compactModel.model || compressionState.config.compactModel;
    const found = selectedProvider?.models.find((m) => m.id === modelId);
    return found?.label || modelId || conversationText.notSet;
  }, [compressionState.compactModel.model, compressionState.config.compactModel, conversationText.notSet, selectedProvider]);

  useEffect(() => {
    let cancelled = false;
    async function loadCompressionConfig() {
      try {
        const state = await ipcService.invoke(IPC_CHANNELS.CONTEXT_COMPRESSION_CONFIG_GET);
        if (!cancelled && state) {
          setCompressionState(state);
        }
      } catch (error) {
        toast.error(conversationText.loadFailedPrefix + getErrorMessage(error, conversationText.unknownError));
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
      toast.error(conversationText.saveFailedPrefix + getErrorMessage(error, conversationText.unknownError));
    } finally {
      setSavingCompression(false);
    }
  };

  return (
    <SettingsPage
      title={conversationText.title}
      description={conversationText.description}
    >
      <SettingsSection title={conversationText.section.title} description={conversationText.section.description}>
        {compressionLoading ? (
          <div className="text-xs text-zinc-500">{t.common.loading}</div>
        ) : (
          <div className="space-y-4">
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <SlidersHorizontal className="w-4 h-4 text-zinc-400" />
                <div>
                  <div className="text-sm font-medium text-zinc-200">{conversationText.autoCompact.title}</div>
                  <div className="text-xs text-zinc-500 mt-0.5">
                    {compressionState.config.enabled
                      ? conversationText.autoCompact.enabledDescription
                      : conversationText.autoCompact.disabledDescription}
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

            <div className="rounded-lg border border-white/[0.08] bg-white/[0.02] p-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-[11px] uppercase tracking-[0.08em] text-zinc-500">{conversationText.model.label}</div>
                  <div className="mt-1 text-sm text-zinc-200">
                    {compressionState.compactModel.provider || compressionState.config.compactProvider}
                    {' / '}
                    {selectedModelLabel}
                  </div>
                  <div className="mt-1 text-[11px] text-zinc-500">
                    {conversationText.model.description}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => openSettingsTab('model')}
                  className="inline-flex items-center gap-1 rounded-md border border-white/[0.08] bg-zinc-900/60 px-2 py-1 text-[11px] text-zinc-300 hover:border-white/[0.16] hover:text-zinc-100"
                >
                  {conversationText.model.manageButton}
                  <ArrowUpRight className="h-3 w-3" />
                </button>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2 text-[11px] text-zinc-500">
              <span className="inline-flex items-center gap-1.5 rounded-md border border-emerald-500/30 bg-emerald-500/10 px-2 py-1 text-emerald-300">
                <CheckCircle2 className="w-3.5 h-3.5" />
                {conversationText.features.manifestPrefix}{featureLabel(compressionState.features.manifest, conversationText.featureStates)}
              </span>
              <span className="inline-flex items-center gap-1.5 rounded-md border border-sky-500/30 bg-sky-500/10 px-2 py-1 text-sky-300">
                <RotateCcw className="w-3.5 h-3.5" />
                {conversationText.features.hooksPrefix}{featureLabel(compressionState.features.hooks, conversationText.featureStates)}
              </span>
              <span>
                {conversationText.features.runtimePrefix}
                {compressionState.runtime.compressionCount}
                {conversationText.features.runtimeMiddle}
                {tokensLabel(compressionState.runtime.totalSavedTokens, conversationText.notSet)}
                {conversationText.features.runtimeSuffix}
              </span>
              {savingCompression && <span>{t.common.saving}</span>}
            </div>

            <SettingsDetails
              title={conversationText.details.title}
              description={conversationText.details.description}
            >
              <div className="space-y-4">
                <div className="grid grid-cols-3 gap-2">
                  <div className="rounded-lg border border-white/[0.08] bg-white/[0.02] p-3">
                    <div className="text-[11px] text-zinc-500">{conversationText.details.preserveRecent}</div>
                    <div className="mt-1 flex items-center gap-2">
                      <input
                        type="number"
                        min={2}
                        max={50}
                        value={compressionState.config.preserveRecentCount}
                        onChange={(event) => updateCompression({ preserveRecentCount: Number(event.target.value) })}
                        className="w-16 rounded-md border border-white/[0.08] bg-zinc-900 px-2 py-1 text-sm text-zinc-200 outline-hidden focus:border-zinc-500"
                      />
                      <span className="text-xs text-zinc-500">{conversationText.details.messagesSuffix}</span>
                    </div>
                  </div>

                  <div className="rounded-lg border border-white/[0.08] bg-white/[0.02] p-3">
                    <div className="flex items-center justify-between text-[11px] text-zinc-500">
                      <span>{conversationText.details.warningThreshold}</span>
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
                      <span>{conversationText.details.criticalThreshold}</span>
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

                <div className="grid grid-cols-2 gap-2">
                  <label className="rounded-lg border border-white/[0.08] bg-white/[0.02] p-3">
                    <span className="text-[11px] text-zinc-500">{conversationText.details.triggerTokens}</span>
                    <div className="mt-2 flex items-center gap-2">
                      <input
                        type="number"
                        min={16}
                        max={1000}
                        value={Math.round((compressionState.config.triggerTokens ?? 100000) / 1000)}
                        onChange={(event) => updateCompression({ triggerTokens: Number(event.target.value) * 1000 })}
                        className="w-20 rounded-md border border-white/[0.08] bg-zinc-900 px-2 py-1 text-sm text-zinc-200 outline-hidden focus:border-zinc-500"
                      />
                      <span className="text-xs text-zinc-500">K tokens</span>
                    </div>
                  </label>

                  <button
                    type="button"
                    onClick={() => updateCompression({ auditEnabled: !compressionState.config.auditEnabled })}
                    className={`inline-flex items-center justify-center gap-1.5 rounded-lg border px-2 py-1 text-xs transition-colors ${
                      compressionState.config.auditEnabled
                        ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
                        : 'border-white/[0.08] bg-white/[0.02] text-zinc-400'
                    }`}
                  >
                    <FileCheck2 className="w-3.5 h-3.5" />
                    {conversationText.details.auditPrefix}{featureLabel(compressionState.features.audit, conversationText.featureStates)}
                  </button>
                </div>
              </div>
            </SettingsDetails>
          </div>
        )}
      </SettingsSection>

      <div className="flex items-start gap-2 px-3 py-2 rounded-lg bg-zinc-800/40 border border-white/[0.06]">
        <Info className="w-3.5 h-3.5 text-zinc-500 flex-shrink-0 mt-0.5" />
        <p className="text-[11px] text-zinc-500 leading-relaxed">
          {conversationText.info}
        </p>
      </div>
    </SettingsPage>
  );
};
