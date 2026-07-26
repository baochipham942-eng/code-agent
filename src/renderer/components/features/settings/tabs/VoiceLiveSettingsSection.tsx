// ============================================================================
// VoiceLiveSettingsSection —— 设置 → 语音「实时通话」组（B5，§7.6 IA）
//
// 总开关 / 通话模型·Provider（只读 + 配置状态）/ 音色（实测白名单）/ 语言 /
// 打断方式三态 + 灵敏度 / 隐私说明（§8.3）。配额说明与热键自定义本批不做。
// 口述输入组在 VoiceInputSettings，同页归并。
// ============================================================================

import React, { useEffect, useState } from 'react';
import { Check, ShieldCheck } from 'lucide-react';
import { IPC_DOMAINS } from '@shared/ipc';
import type { AppSettings } from '@shared/contract';
import { VOICE_LIVE_SETTINGS_UPDATED_EVENT } from '@shared/contract/voice';
import type { VoiceLiveSettings } from '@shared/contract/settings';
import { QWEN_OMNI_REALTIME_MODEL, QWEN_OMNI_REALTIME_VOICE_WHITELIST } from '@shared/constants/voice';
import ipcService from '../../../../services/ipcService';
import { createLogger } from '../../../../utils/logger';
import { useI18n } from '../../../../hooks/useI18n';
import { Toggle } from '../../../primitives/Toggle';
import { useVoiceLiveAvailability } from '../../voice/useVoiceLiveAvailability';
import { deriveInterruptMode, deriveTurnDetection, deriveVadSensitivity } from '../../voice/voiceSettingsDerivation';

const logger = createLogger('VoiceLiveSettings');

type InterruptMode = NonNullable<VoiceLiveSettings['interrupt']>;
type VadSensitivity = NonNullable<VoiceLiveSettings['vadSensitivity']>;

const INTERRUPT_OPTIONS: InterruptMode[] = ['server_vad', 'push_to_talk', 'manual'];
const SENSITIVITY_OPTIONS: VadSensitivity[] = ['low', 'medium', 'high'];

export const VoiceLiveSettingsSection: React.FC = () => {
  const { t } = useI18n();
  const text = t.voice.settings;
  const { configured } = useVoiceLiveAvailability();

  const [enabled, setEnabled] = useState(false);
  const [voiceId, setVoiceId] = useState<string>(QWEN_OMNI_REALTIME_VOICE_WHITELIST[0]);
  const [language, setLanguage] = useState<NonNullable<VoiceLiveSettings['language']>>('auto');
  const [interrupt, setInterrupt] = useState<InterruptMode>('server_vad');
  const [sensitivity, setSensitivity] = useState<VadSensitivity>('medium');

  useEffect(() => {
    let cancelled = false;
    void ipcService.invokeDomain<AppSettings>(IPC_DOMAINS.SETTINGS, 'get')
      .then((settings) => {
        if (cancelled) return;
        const voice = settings.voice;
        setEnabled(voice?.live?.enabled === true);
        setVoiceId(voice?.live?.voiceId ?? QWEN_OMNI_REALTIME_VOICE_WHITELIST[0]);
        setLanguage(voice?.live?.language ?? 'auto');
        setInterrupt(deriveInterruptMode(voice));
        setSensitivity(deriveVadSensitivity(voice));
      })
      .catch((error) => logger.error('load voice live settings failed', error));
    return () => { cancelled = true; };
  }, []);

  const persist = async (patch: Partial<VoiceLiveSettings>) => {
    const nextLive: VoiceLiveSettings = {
      enabled,
      voiceId,
      language,
      interrupt,
      vadSensitivity: sensitivity,
      ...patch,
    };
    // 应用到本地 state
    if (patch.enabled !== undefined) setEnabled(patch.enabled);
    if (patch.voiceId !== undefined) setVoiceId(patch.voiceId);
    if (patch.language !== undefined) setLanguage(patch.language);
    if (patch.interrupt !== undefined) setInterrupt(patch.interrupt);
    if (patch.vadSensitivity !== undefined) setSensitivity(patch.vadSensitivity);

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

  const interruptText: Record<InterruptMode, { label: string; desc: string }> = {
    server_vad: { label: text.interruptServerVad, desc: text.interruptServerVadDesc },
    push_to_talk: { label: text.interruptPtt, desc: text.interruptPttDesc },
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

      {/* 通话模型 / Provider：一期只有 Qwen-Omni 一路，只读展示 + 配置状态（§9.3 引导） */}
      <div className="border-t border-zinc-700 pt-4">
        <div className="flex items-center justify-between gap-4">
          <div>
            <h3 className="mb-1 text-sm font-medium text-zinc-200">{text.providerTitle}</h3>
            <p className="text-xs text-zinc-500">Qwen-Omni · {QWEN_OMNI_REALTIME_MODEL}</p>
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
        {!configured && <p className="mt-2 text-xs text-amber-400/80">{text.providerMissingHint}</p>}
      </div>

      <div className="grid grid-cols-2 gap-4 border-t border-zinc-700 pt-4">
        <label className="space-y-2">
          <span className="text-sm font-medium text-zinc-200">{text.voiceLabel}</span>
          <select
            value={voiceId}
            onChange={(event) => void persist({ voiceId: event.target.value })}
            className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-200 outline-none focus:border-primary-500"
          >
            {QWEN_OMNI_REALTIME_VOICE_WHITELIST.map((id) => (
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
        <h3 className="mb-3 text-sm font-medium text-zinc-200">{text.interruptTitle}</h3>
        <div className="grid grid-cols-3 gap-3">
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
