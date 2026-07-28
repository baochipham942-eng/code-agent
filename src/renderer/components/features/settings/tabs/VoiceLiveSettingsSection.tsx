// ============================================================================
// VoiceLiveSettingsSection —— 设置 → 语音「实时通话」组（B5，§7.6 IA）
//
// 总开关 / 通话模型·Provider（白名单可配 + 配置状态）/ 音色（按所选模型的白名单出项）/ 语言 /
// 打断方式三态 + 灵敏度 / 隐私说明（§8.3）。配额说明与热键自定义本批不做。
// 独立「实时通话」tab（VoiceLiveSettings 薄壳）；口述输入在「语音转文字」tab。
// ============================================================================

import React, { useEffect, useState } from 'react';
import { Check, ShieldCheck } from 'lucide-react';
import { IPC_DOMAINS } from '@shared/ipc';
import type { AppSettings } from '@shared/contract';
import { VOICE_LIVE_SETTINGS_UPDATED_EVENT } from '@shared/contract/voice';
import type { VoiceLiveSettings } from '@shared/contract/settings';
import {
  QWEN_OMNI_REALTIME_MODEL,
  QWEN_OMNI_REALTIME_MODEL_OPTIONS,
  resolveConversationModelOption,
} from '@shared/constants/voice';
import { PROVIDER_MODELS, PROVIDER_MODELS_MAP } from '@shared/constants/models';
import ipcService from '../../../../services/ipcService';
import { createLogger } from '../../../../utils/logger';
import { useI18n } from '../../../../hooks/useI18n';
import { Toggle } from '../../../primitives/Toggle';
import { useVoiceLiveAvailability } from '../../voice/useVoiceLiveAvailability';
import { deriveInterruptMode, deriveTurnDetection, deriveVadSensitivity } from '../../voice/voiceSettingsDerivation';

const logger = createLogger('VoiceLiveSettings');

type InterruptMode = NonNullable<VoiceLiveSettings['interrupt']>;
type VadSensitivity = NonNullable<VoiceLiveSettings['vadSensitivity']>;
type EchoCancellationMode = NonNullable<VoiceLiveSettings['echoCancellation']>;

const INTERRUPT_OPTIONS: InterruptMode[] = ['server_vad', 'manual'];
const SENSITIVITY_OPTIONS: VadSensitivity[] = ['low', 'medium', 'high'];

export const VoiceLiveSettingsSection: React.FC = () => {
  const { t } = useI18n();
  const text = t.voice.settings;
  const { configured, usage } = useVoiceLiveAvailability();

  const [enabled, setEnabled] = useState(false);
  const [conversationModel, setConversationModel] = useState<string>(QWEN_OMNI_REALTIME_MODEL);
  const [voiceId, setVoiceId] = useState<string>(QWEN_OMNI_REALTIME_MODEL_OPTIONS[0].voices[0]);
  const [language, setLanguage] = useState<NonNullable<VoiceLiveSettings['language']>>('auto');
  const [interrupt, setInterrupt] = useState<InterruptMode>('server_vad');
  const [sensitivity, setSensitivity] = useState<VadSensitivity>('medium');
  const [executionModel, setExecutionModel] = useState<VoiceLiveSettings['executionModel']>(undefined);
  const [echoCancellation, setEchoCancellation] = useState<EchoCancellationMode>('auto');

  useEffect(() => {
    let cancelled = false;
    void ipcService.invokeDomain<AppSettings>(IPC_DOMAINS.SETTINGS, 'get')
      .then((settings) => {
        if (cancelled) return;
        const voice = settings.voice;
        const modelOption = resolveConversationModelOption(voice?.live?.conversationModel);
        setEnabled(voice?.live?.enabled === true);
        setConversationModel(modelOption.id);
        // 音色与模型强绑定：存量 voiceId 不在当前模型的 voices 里就落到第一个合法值，
        // 别把「3.5 的音色 + 上一代模型」这种组合留在 UI 上（第一次合成才 400）。
        const storedVoiceId = voice?.live?.voiceId;
        setVoiceId(storedVoiceId && (modelOption.voices as readonly string[]).includes(storedVoiceId)
          ? storedVoiceId
          : modelOption.voices[0]);
        setLanguage(voice?.live?.language ?? 'auto');
        setInterrupt(deriveInterruptMode(voice));
        setSensitivity(deriveVadSensitivity(voice));
        setExecutionModel(voice?.live?.executionModel);
        setEchoCancellation(voice?.live?.echoCancellation ?? 'auto');
      })
      .catch((error) => logger.error('load voice live settings failed', error));
    return () => { cancelled = true; };
  }, []);

  const persist = async (patch: Partial<VoiceLiveSettings>) => {
    const nextLive: VoiceLiveSettings = {
      enabled,
      conversationModel,
      voiceId,
      language,
      interrupt,
      vadSensitivity: sensitivity,
      ...(executionModel ? { executionModel } : {}),
      echoCancellation,
      ...patch,
    };
    // 应用到本地 state
    if (patch.enabled !== undefined) setEnabled(patch.enabled);
    if (patch.conversationModel !== undefined) setConversationModel(patch.conversationModel);
    if (patch.voiceId !== undefined) setVoiceId(patch.voiceId);
    if (patch.language !== undefined) setLanguage(patch.language);
    if (patch.interrupt !== undefined) setInterrupt(patch.interrupt);
    if (patch.vadSensitivity !== undefined) setSensitivity(patch.vadSensitivity);
    if (patch.echoCancellation !== undefined) setEchoCancellation(patch.echoCancellation);

    const nextInterrupt = patch.interrupt ?? interrupt;
    const nextSensitivity = patch.vadSensitivity ?? sensitivity;
    try {
      await ipcService.invokeDomain(IPC_DOMAINS.SETTINGS, 'set', {
        voice: {
          // 运行时真源 turnDetection 与 UI 三态一起写，两侧不分叉
          turnDetection: deriveTurnDetection(nextInterrupt, nextSensitivity),
          live: nextLive,
        },
      } as Partial<AppSettings>);
      window.dispatchEvent(new CustomEvent(VOICE_LIVE_SETTINGS_UPDATED_EVENT));
    } catch (error) {
      logger.error('save voice live settings failed', error);
    }
  };

  /** 传 undefined = 回到「跟随会话默认引擎」（把键去掉，不是写一个空值）。 */
  const persistExecutionModel = async (next: VoiceLiveSettings['executionModel']) => {
    setExecutionModel(next);
    await persist({ executionModel: next });
  };

  /**
   * 换通话模型必须把音色一起落回新模型的白名单——音色枚举与模型强绑定，
   * 留下「旧模型音色 + 新模型」的组合，上游第一次真合成才 400（建连时不报）。
   */
  const persistConversationModel = async (nextId: string) => {
    const option = resolveConversationModelOption(nextId);
    const nextVoiceId = (option.voices as readonly string[]).includes(voiceId) ? voiceId : option.voices[0];
    await persist({ conversationModel: option.id, voiceId: nextVoiceId });
  };

  const conversationModelOption = resolveConversationModelOption(conversationModel);

  const interruptText: Record<InterruptMode, { label: string; desc: string }> = {
    server_vad: { label: text.interruptServerVad, desc: text.interruptServerVadDesc },
    manual: { label: text.interruptManual, desc: text.interruptManualDesc },
  };
  const sensitivityText: Record<VadSensitivity, string> = {
    low: text.sensitivityLow,
    medium: text.sensitivityMedium,
    high: text.sensitivityHigh,
  };

  return (
    <div className="space-y-6" data-testid="voice-live-settings">
      <div className="flex items-center justify-between">
        <div className="pr-4">
          <h3 className="mb-1 text-sm font-medium text-zinc-200">{text.enableTitle}</h3>
          <p className="text-xs text-zinc-500">{text.enableDescription}</p>
        </div>
        <Toggle
          size="md"
          checked={enabled}
          onChange={(next) => void persist({ enabled: next })}
          aria-label={text.enableTitle}
        />
      </div>

      {/* 通话模型 / Provider：白名单可配（工单③）。不支持 tools 的模型选中时当场说清代价 */}
      <div className="border-t border-zinc-700 pt-4">
        <div className="flex items-center justify-between gap-4">
          <div>
            <h3 className="mb-1 text-sm font-medium text-zinc-200">{text.providerTitle}</h3>
            <p className="text-xs text-zinc-500">Qwen-Omni</p>
          </div>
          <span
            data-testid="voice-provider-status"
            className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] ${
              configured ? 'bg-emerald-500/10 text-emerald-300' : 'bg-amber-500/10 text-amber-300'
            }`}
          >
            {configured ? text.providerConfigured : text.providerMissing}
          </span>
        </div>
        <select
          data-testid="voice-conversation-model"
          value={conversationModel}
          onChange={(event) => void persistConversationModel(event.target.value)}
          className="mt-3 w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-200 outline-none focus:border-primary-500"
        >
          {QWEN_OMNI_REALTIME_MODEL_OPTIONS.map((option) => (
            <option key={option.id} value={option.id}>{option.id}</option>
          ))}
        </select>
        {!conversationModelOption.supportsTools && (
          <p data-testid="voice-model-no-tools-warning" className="mt-2 text-xs text-amber-400/80">
            {text.modelNoToolsWarning}
          </p>
        )}
        {!configured && <p className="mt-2 text-xs text-amber-400/80">{text.providerMissingHint}</p>}
      </div>

      {/* 执行引擎（§6.1 双脑）：通话模型只负责听说，真干活是另一个模型，两者分开看分开配 */}
      <div className="border-t border-zinc-700 pt-4">
        <h3 className="mb-1 text-sm font-medium text-zinc-200">{text.executionModelTitle}</h3>
        <p className="mb-3 text-xs text-zinc-500">{text.executionModelDescription}</p>
        <div className="grid grid-cols-2 gap-4">
          <select
            data-testid="voice-execution-provider"
            value={executionModel?.provider ?? ''}
            onChange={(event) => {
              const provider = event.target.value;
              if (!provider) return void persistExecutionModel(undefined);
              const first = PROVIDER_MODELS_MAP[provider]?.models[0]?.id;
              return void persistExecutionModel(first ? { provider, model: first } : undefined);
            }}
            className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-200 outline-none focus:border-primary-500"
          >
            <option value="">{text.executionModelFollowSession}</option>
            {PROVIDER_MODELS.map((provider) => (
              <option key={provider.id} value={provider.id}>{provider.name}</option>
            ))}
          </select>
          <select
            data-testid="voice-execution-model"
            value={executionModel?.model ?? ''}
            disabled={!executionModel}
            onChange={(event) => {
              if (!executionModel) return;
              void persistExecutionModel({ provider: executionModel.provider, model: event.target.value });
            }}
            className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-200 outline-none focus:border-primary-500 disabled:opacity-40"
          >
            {executionModel
              ? (PROVIDER_MODELS_MAP[executionModel.provider]?.models ?? []).map((model) => (
                <option key={model.id} value={model.id}>{model.label}</option>
              ))
              : <option value="">{text.executionModelFollowSession}</option>}
          </select>
        </div>
      </div>

      {/* 本月通话用量：只记账不设限（方案 §5.4，产品负责人 2026-07-27 拍板） */}
      <div className="border-t border-zinc-700 pt-4">
        <h3 className="mb-1 text-sm font-medium text-zinc-200">{text.usageTitle}</h3>
        <p className="text-xs text-zinc-500" data-testid="voice-usage-summary">
          {text.usageThisMonth
            .replace('{minutes}', String(Math.round(usage.monthSeconds / 60)))
            .replace('{calls}', String(usage.monthCalls))}
        </p>
      </div>

      <div className="grid grid-cols-2 gap-4 border-t border-zinc-700 pt-4">
        <label className="space-y-2">
          <span className="text-sm font-medium text-zinc-200">{text.voiceLabel}</span>
          <select
            value={voiceId}
            onChange={(event) => void persist({ voiceId: event.target.value })}
            className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-200 outline-none focus:border-primary-500"
          >
            {conversationModelOption.voices.map((id) => (
              <option key={id} value={id}>{id}</option>
            ))}
          </select>
          <p className="text-xs text-zinc-500">{text.voiceNote}</p>
        </label>

        <label className="space-y-2">
          <span className="text-sm font-medium text-zinc-200">{text.languageLabel}</span>
          <select
            value={language}
            onChange={(event) => void persist({ language: event.target.value as NonNullable<VoiceLiveSettings['language']> })}
            className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-200 outline-none focus:border-primary-500"
          >
            <option value="auto">{text.languageAuto}</option>
            <option value="zh">{text.languageZh}</option>
            <option value="en">{text.languageEn}</option>
          </select>
        </label>
      </div>

      <div className="border-t border-zinc-700 pt-4">
        <label className="block space-y-2">
          <span className="text-sm font-medium text-zinc-200">{text.echoCancellationTitle}</span>
          <select
            data-testid="voice-echo-cancellation"
            value={echoCancellation}
            onChange={(event) => void persist({
              echoCancellation: event.target.value as EchoCancellationMode,
            })}
            className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-200 outline-none focus:border-primary-500"
          >
            <option value="auto">{text.echoCancellationAuto}</option>
            <option value="off">{text.echoCancellationOff}</option>
          </select>
          <p className="text-xs leading-5 text-zinc-500">
            {echoCancellation === 'auto'
              ? text.echoCancellationAutoDesc
              : text.echoCancellationOffDesc}
          </p>
        </label>
      </div>

      <div className="border-t border-zinc-700 pt-4">
        <h3 className="mb-3 text-sm font-medium text-zinc-200">{text.interruptTitle}</h3>
        <div className="grid grid-cols-2 gap-3">
          {INTERRUPT_OPTIONS.map((option) => {
            const active = interrupt === option;
            return (
              <button
                key={option}
                type="button"
                data-testid={`voice-interrupt-${option}`}
                onClick={() => void persist({ interrupt: option })}
                className={`relative rounded-lg border p-3 text-left transition-all ${
                  active
                    ? 'border-zinc-500 bg-zinc-800/60 ring-1 ring-white/10'
                    : 'border-zinc-700 hover:border-zinc-600 hover:bg-zinc-800'
                }`}
              >
                <div className="text-sm font-medium text-zinc-300">{interruptText[option].label}</div>
                <p className="mt-1 text-xs leading-5 text-zinc-500">{interruptText[option].desc}</p>
                {active && (
                  <span className="absolute right-2 top-2 flex h-5 w-5 items-center justify-center rounded-full bg-zinc-200">
                    <Check className="h-3 w-3 text-zinc-950" />
                  </span>
                )}
              </button>
            );
          })}
        </div>

        {interrupt === 'server_vad' && (
          <label className="mt-4 block space-y-2">
            <span className="text-sm font-medium text-zinc-200">{text.sensitivityLabel}</span>
            <select
              data-testid="voice-vad-sensitivity"
              value={sensitivity}
              onChange={(event) => void persist({ vadSensitivity: event.target.value as VadSensitivity })}
              className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-200 outline-none focus:border-primary-500"
            >
              {SENSITIVITY_OPTIONS.map((option) => (
                <option key={option} value={option}>{sensitivityText[option]}</option>
              ))}
            </select>
          </label>
        )}
      </div>

      <div className="flex items-start gap-3 rounded-lg border border-zinc-700 bg-zinc-900/60 p-3">
        <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-zinc-400" />
        <div>
          <div className="text-sm font-medium text-zinc-200">{text.privacyTitle}</div>
          <p className="mt-1 text-xs leading-5 text-zinc-500">{text.privacyBody}</p>
        </div>
      </div>
    </div>
  );
};

export default VoiceLiveSettingsSection;
