// ============================================================================
// VoiceLiveSettingsSection —— 设置 → 语音「实时语音」组（B5，§7.6 IA）
//
// 总开关 / 语言 / 打断方式三态 + 灵敏度 / 回声消除 / 通话用量 / 隐私说明（§8.3）。
// T1（2026-07-28）：通话模型·Provider 与音色搬去「模型与能力」组的「语音模型」tab
// （VoiceModelSettings），本 tab 只留使用偏好；persist 透传本 tab 不拥有的 live 键。
// 独立「实时语音」tab（VoiceLiveSettings 薄壳）；口述输入在「语音转文字」tab。
// ============================================================================

import React, { useEffect, useRef, useState } from 'react';
import { Check, ShieldCheck } from 'lucide-react';
import { IPC_DOMAINS } from '@shared/ipc';
import type { AppSettings } from '@shared/contract';
import { VOICE_LIVE_SETTINGS_UPDATED_EVENT } from '@shared/contract/voice';
import type { VoiceInputDeviceSettings, VoiceLiveSettings } from '@shared/contract/settings';
import { normalizeVoiceInputDevice } from '@shared/voiceInputDevice';
import { PROVIDER_MODELS, PROVIDER_MODELS_MAP } from '@shared/constants/models';
import ipcService from '../../../../services/ipcService';
import { createLogger } from '../../../../utils/logger';
import { useI18n } from '../../../../hooks/useI18n';
import { Toggle } from '../../../primitives/Toggle';
import { useVoiceLiveAvailability } from '../../voice/useVoiceLiveAvailability';
import { deriveInterruptMode, deriveTurnDetection, deriveVadSensitivity } from '../../voice/voiceSettingsDerivation';
import { resolveVoiceInputDevice } from '../../../../services/voiceAudioPipeline';

const logger = createLogger('VoiceLiveSettings');

type InterruptMode = NonNullable<VoiceLiveSettings['interrupt']>;
type VadSensitivity = NonNullable<VoiceLiveSettings['vadSensitivity']>;
type EchoCancellationMode = NonNullable<VoiceLiveSettings['echoCancellation']>;
type SpeechRate = NonNullable<VoiceLiveSettings['speechRate']>;

const INTERRUPT_OPTIONS: InterruptMode[] = ['server_vad', 'manual'];
const SENSITIVITY_OPTIONS: VadSensitivity[] = ['low', 'medium', 'high'];
const SPEECH_RATE_OPTIONS: SpeechRate[] = ['slow', 'normal', 'fast'];

export const VoiceLiveSettingsSection: React.FC = () => {
  const { t } = useI18n();
  const text = t.voice.settings;
  const { usage } = useVoiceLiveAvailability();

  // baseLive 透传本 tab 不拥有的 live 键（通话模型/音色已搬「语音模型」tab），
  // persist 时原样带回，避免整对象写入把它们抹掉。
  const [baseLive, setBaseLive] = useState<VoiceLiveSettings>({});
  const [enabled, setEnabled] = useState(false);
  const [language, setLanguage] = useState<NonNullable<VoiceLiveSettings['language']>>('auto');
  const [interrupt, setInterrupt] = useState<InterruptMode>('server_vad');
  const [sensitivity, setSensitivity] = useState<VadSensitivity>('medium');
  const [executionModel, setExecutionModel] = useState<VoiceLiveSettings['executionModel']>(undefined);
  const [echoCancellation, setEchoCancellation] = useState<EchoCancellationMode>('auto');
  // 未配置 = normal（契约默认档），存量用户打开设置页不该看到"什么都没选"
  const [speechRate, setSpeechRate] = useState<SpeechRate>('normal');
  const [inputDevices, setInputDevices] = useState<MediaDeviceInfo[]>([]);
  const [inputDevice, setInputDevice] = useState<VoiceInputDeviceSettings | null>(null);
  const [inputDeviceAvailable, setInputDeviceAvailable] = useState<boolean | null>(null);
  const [inputDeviceRecovered, setInputDeviceRecovered] = useState(false);
  const [inputDeviceEnumFailed, setInputDeviceEnumFailed] = useState(false);
  const prevInputDeviceAvailableRef = useRef<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;
    void ipcService.invokeDomain<AppSettings>(IPC_DOMAINS.SETTINGS, 'get')
      .then((settings) => {
        if (cancelled) return;
        const voice = settings.voice;
        setBaseLive(voice?.live ?? {});
        setEnabled(voice?.live?.enabled === true);
        setLanguage(voice?.live?.language ?? 'auto');
        setInterrupt(deriveInterruptMode(voice));
        setSensitivity(deriveVadSensitivity(voice));
        setExecutionModel(voice?.live?.executionModel);
        setEchoCancellation(voice?.live?.echoCancellation ?? 'auto');
        setSpeechRate(voice?.live?.speechRate ?? 'normal');
        setInputDevice(normalizeVoiceInputDevice(voice?.inputDevice) ?? null);
      })
      .catch((error) => logger.error('load voice live settings failed', error));
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    let cancelled = false;
    let removeListener: (() => void) | null = null;

    const refresh = async (source: 'initial' | 'devicechange' = 'initial') => {
      try {
        if (typeof navigator === 'undefined' || !navigator.mediaDevices || typeof navigator.mediaDevices.enumerateDevices !== 'function') {
          throw new Error('enumerateDevices is unavailable');
        }
        const devices = await navigator.mediaDevices.enumerateDevices();
        if (cancelled) return;
        const audioInputs = devices.filter((device) => device.kind === 'audioinput');
        setInputDevices(audioInputs);
        setInputDeviceEnumFailed(false);
        const nextAvailable = inputDevice
          ? resolveVoiceInputDevice(inputDevice, audioInputs).match !== 'default'
          : null;
        const prevAvailable = prevInputDeviceAvailableRef.current;
        setInputDeviceAvailable(nextAvailable);
        prevInputDeviceAvailableRef.current = nextAvailable;
        // 只有 devicechange 里「曾断开 → 又恢复」才显示恢复文案；初始可用只显示普通可用。
        setInputDeviceRecovered(source === 'devicechange' && prevAvailable === false && nextAvailable === true);
      } catch (error) {
        if (cancelled) return;
        logger.error('enumerate input devices failed', error);
        setInputDeviceEnumFailed(true);
        setInputDeviceAvailable(null);
        prevInputDeviceAvailableRef.current = null;
        setInputDeviceRecovered(false);
      }
    };

    void refresh();
    if (navigator?.mediaDevices?.addEventListener) {
      const handler = () => { void refresh('devicechange'); };
      navigator.mediaDevices.addEventListener('devicechange', handler);
      removeListener = () => navigator.mediaDevices.removeEventListener('devicechange', handler);
    }

    return () => {
      cancelled = true;
      removeListener?.();
    };
  }, [inputDevice]);

  const persist = async (patch: Partial<VoiceLiveSettings>) => {
    const nextLive: VoiceLiveSettings = {
      ...baseLive,
      enabled,
      language,
      interrupt,
      vadSensitivity: sensitivity,
      ...(executionModel ? { executionModel } : {}),
      echoCancellation,
      speechRate,
      ...patch,
    };
    // executionModel 清空 = 回到「跟随会话默认引擎」（把键去掉，不是写一个空值）
    if (!nextLive.executionModel) delete nextLive.executionModel;
    // 应用到本地 state
    if (patch.enabled !== undefined) setEnabled(patch.enabled);
    if (patch.language !== undefined) setLanguage(patch.language);
    if (patch.interrupt !== undefined) setInterrupt(patch.interrupt);
    if (patch.vadSensitivity !== undefined) setSensitivity(patch.vadSensitivity);
    if (patch.echoCancellation !== undefined) setEchoCancellation(patch.echoCancellation);
    if (patch.speechRate !== undefined) setSpeechRate(patch.speechRate);

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
      setBaseLive(nextLive);
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

  const persistInputDevice = async (next: VoiceInputDeviceSettings | null) => {
    setInputDevice(next);
    try {
      await ipcService.invokeDomain(IPC_DOMAINS.SETTINGS, 'set', {
        voice: { inputDevice: next },
      } as Partial<AppSettings>);
    } catch (error) {
      logger.error('save input device failed', error);
    }
  };

  const interruptText: Record<InterruptMode, { label: string; desc: string }> = {
    server_vad: { label: text.interruptServerVad, desc: text.interruptServerVadDesc },
    manual: { label: text.interruptManual, desc: text.interruptManualDesc },
  };
  const sensitivityText: Record<VadSensitivity, string> = {
    low: text.sensitivityLow,
    medium: text.sensitivityMedium,
    high: text.sensitivityHigh,
  };
  const speechRateText: Record<SpeechRate, string> = {
    slow: text.speechRateSlow,
    normal: text.speechRateNormal,
    fast: text.speechRateFast,
  };

  const inputDeviceResolution = inputDevice ? resolveVoiceInputDevice(inputDevice, inputDevices) : undefined;
  const selectedInputDeviceId = inputDeviceResolution?.match !== 'default' ? inputDeviceResolution?.deviceId ?? '' : '';
  const inputDeviceStatus = (() => {
    if (!inputDevice) return null;
    if (inputDeviceEnumFailed) return text.inputDeviceEnumFailed;
    if (inputDeviceRecovered) return text.inputDeviceRecovered;
    if (inputDeviceAvailable === true) return text.inputDeviceAvailable;
    if (inputDeviceAvailable === false) return text.inputDeviceUnavailable;
    return null;
  })();

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
            .replace('{calls}', String(usage.monthCalls))
            .replace('{tokens}', usage.monthTokens ? String(usage.monthTokens.totalTokens) : text.usageTokensUnavailable)}
        </p>
      </div>

      {/* 麦克风输入设备：显式选择或系统默认；断开时保留配置并回退 */}
      <div className="border-t border-zinc-700 pt-4" data-testid="voice-input-device-section">
        <h3 className="mb-1 text-sm font-medium text-zinc-200">{text.inputDeviceTitle}</h3>
        <p className="mb-3 text-xs text-zinc-500">{text.inputDeviceDescription}</p>
        <select
          data-testid="voice-input-device"
          value={selectedInputDeviceId}
          onChange={(event) => {
            const value = event.target.value;
            if (!value) return void persistInputDevice(null);
            const device = inputDevices.find((d) => d.deviceId === value);
            if (!device) return;
            return void persistInputDevice({
              label: device.label.trim() || device.deviceId,
              webDeviceId: device.deviceId,
            });
          }}
          className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-200 outline-none focus:border-primary-500"
        >
          <option value="">{text.inputDeviceDefault}</option>
          {inputDevices.map((device) => (
            <option key={device.deviceId} value={device.deviceId}>{device.label || device.deviceId}</option>
          ))}
        </select>
        {inputDeviceStatus && (
          <p className="mt-2 text-xs leading-5 text-zinc-500" data-testid="voice-input-device-status">
            {inputDeviceStatus}
          </p>
        )}
      </div>

      <div className="border-t border-zinc-700 pt-4">
        <label className="block space-y-2">
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

      {/* 语速三档（T7）：控件形态照本 section 的 VAD 灵敏度 select；
          helper 如实提示这是说话建议、遵从度因语音服务而异（方案 §2 不许虚假承诺） */}
      <div className="border-t border-zinc-700 pt-4">
        <label className="block space-y-2">
          <span className="text-sm font-medium text-zinc-200">{text.speechRateTitle}</span>
          <select
            data-testid="voice-speech-rate"
            value={speechRate}
            onChange={(event) => void persist({ speechRate: event.target.value as SpeechRate })}
            className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-200 outline-none focus:border-primary-500"
          >
            {SPEECH_RATE_OPTIONS.map((option) => (
              <option key={option} value={option}>{speechRateText[option]}</option>
            ))}
          </select>
          <p className="text-xs leading-5 text-zinc-500">{text.speechRateHelper}</p>
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
