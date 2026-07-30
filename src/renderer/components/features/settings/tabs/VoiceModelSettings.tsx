// ============================================================================
// VoiceModelSettings - 语音模型 tab（T1，2026-07-28 产品负责人拍板）
//
// 「模型与能力」组收拢三处模型配置：通话模型（provider + model）/ 音色 / 转写模型。
// 使用偏好留在原 tab：实时语音（打断方式/回声消除/断句灵敏度）、语音转文字
// （转写模式/线程数等）。搬家不是复制——原 tab 不再渲染这三项。
//
// 硬约束：存储 key、默认值、读写路径一律不动——
//   voice.live.conversationModel / voice.live.voiceId / speech.localModel，
// 且 voice.live 写入时 turnDetection 同写（运行时真源契约同 VoiceLiveSettingsSection）。
// ============================================================================

import React, { useEffect, useState } from 'react';
import { IPC_DOMAINS } from '@shared/ipc';
import type { AppSettings, SpeechInputSettings } from '@shared/contract';
import { DEFAULT_SPEECH_INPUT_SETTINGS, VOICE_INPUT_SETTINGS_UPDATED_EVENT } from '@shared/contract';
import { VOICE_LIVE_SETTINGS_UPDATED_EVENT, type VoiceTurnDetectionConfig } from '@shared/contract/voice';
import type { VoiceLiveSettings } from '@shared/contract/settings';
import { QWEN_OMNI_REALTIME_MODEL_OPTIONS, resolveConversationModelOption } from '@shared/constants/voice';
import ipcService from '../../../../services/ipcService';
import { createLogger } from '../../../../utils/logger';
import { useI18n } from '../../../../hooks/useI18n';
import { useVoiceLiveAvailability } from '../../voice/useVoiceLiveAvailability';
import { deriveInterruptMode, deriveTurnDetection, deriveVadSensitivity } from '../../voice/voiceSettingsDerivation';
import { VoiceApiKeyConfig } from './VoiceApiKeyConfig';

const logger = createLogger('VoiceModelSettings');

// 本地 whisper-cpp 转写模型白名单（从 VoiceInputSettings 搬来，唯一渲染处）
const TRANSCRIPTION_MODEL_OPTIONS = [
  { id: 'ggml-large-v3-turbo.bin', label: 'large-v3-turbo' },
  { id: 'ggml-large-v3.bin', label: 'large-v3' },
  { id: 'ggml-medium.bin', label: 'medium' },
  { id: 'ggml-small.bin', label: 'small' },
  { id: 'ggml-base.bin', label: 'base' },
];

function mergeSpeechSettings(value?: Partial<SpeechInputSettings>): SpeechInputSettings {
  return {
    ...DEFAULT_SPEECH_INPUT_SETTINGS,
    ...(value ?? {}),
  };
}

export const VoiceModelSettings: React.FC = () => {
  const { t } = useI18n();
  const text = t.voice.settings;
  const modelText = t.settings.voiceModel;
  const { configured } = useVoiceLiveAvailability();

  const [live, setLive] = useState<VoiceLiveSettings>({});
  const [turnDetection, setTurnDetection] = useState<VoiceTurnDetectionConfig | undefined>(undefined);
  const [speech, setSpeech] = useState<SpeechInputSettings>(DEFAULT_SPEECH_INPUT_SETTINGS);

  useEffect(() => {
    let cancelled = false;
    void ipcService.invokeDomain<AppSettings>(IPC_DOMAINS.SETTINGS, 'get')
      .then((settings) => {
        if (cancelled) return;
        setLive(settings.voice?.live ?? {});
        setTurnDetection(settings.voice?.turnDetection);
        setSpeech(mergeSpeechSettings(settings.speech));
      })
      .catch((error) => logger.error('load voice model settings failed', error));
    return () => { cancelled = true; };
  }, []);

  const persistLive = async (patch: Partial<VoiceLiveSettings>) => {
    const nextLive: VoiceLiveSettings = { ...live, ...patch };
    // 运行时真源 turnDetection 与 UI 三态一起写，两侧不分叉（契约同 VoiceLiveSettingsSection）
    const interrupt = deriveInterruptMode({ turnDetection, live: nextLive });
    const sensitivity = deriveVadSensitivity({ turnDetection, live: nextLive });
    try {
      await ipcService.invokeDomain(IPC_DOMAINS.SETTINGS, 'set', {
        voice: {
          turnDetection: deriveTurnDetection(interrupt, sensitivity),
          live: nextLive,
        },
      } as Partial<AppSettings>);
      setLive(nextLive);
      window.dispatchEvent(new CustomEvent(VOICE_LIVE_SETTINGS_UPDATED_EVENT));
    } catch (error) {
      logger.error('save voice model settings failed', error);
    }
  };

  /**
   * 换通话模型必须把音色一起落回新模型的白名单——音色枚举与模型强绑定，
   * 留下「旧模型音色 + 新模型」的组合，上游第一次真合成才 400（建连时不报）。
   */
  const persistConversationModel = async (nextId: string) => {
    const option = resolveConversationModelOption(nextId);
    const nextVoiceId = (option.voices as readonly string[]).includes(currentVoiceId) ? currentVoiceId : option.voices[0];
    await persistLive({ conversationModel: option.id, voiceId: nextVoiceId });
  };

  const persistSpeech = async (patch: Partial<SpeechInputSettings>) => {
    const next = mergeSpeechSettings({ ...speech, ...patch });
    try {
      await ipcService.invokeDomain(IPC_DOMAINS.SETTINGS, 'set', {
        speech: next,
      } as Partial<AppSettings>);
      setSpeech(next);
      window.dispatchEvent(new CustomEvent(VOICE_INPUT_SETTINGS_UPDATED_EVENT, { detail: next }));
    } catch (error) {
      logger.error('save transcription model settings failed', error);
    }
  };

  const conversationModelOption = resolveConversationModelOption(live.conversationModel);
  // 音色与模型强绑定：存量 voiceId 不在当前模型的 voices 里就落到第一个合法值，
  // 别把「3.5 的音色 + 上一代模型」这种组合留在 UI 上（第一次合成才 400）。
  const currentVoiceId = live.voiceId && (conversationModelOption.voices as readonly string[]).includes(live.voiceId)
    ? live.voiceId
    : conversationModelOption.voices[0];

  return (
    <div className="space-y-6" data-testid="voice-model-settings">
      {/* API Key 常驻在语音模型 tab（批 X3 产品拍板）：key 是模型的配置，
          配没配都展示（形态不同），缺 key 引导态只是入口侧的补救通道 */}
      <VoiceApiKeyConfig />

      {/* 通话模型 / Provider：白名单可配。不支持 tools 的模型选中时当场说清代价 */}
      <div>
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
          value={conversationModelOption.id}
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

      {/* 音色：选项来自当前通话模型的实测白名单 */}
      <div className="border-t border-zinc-700 pt-4">
        <label className="block space-y-2">
          <span className="text-sm font-medium text-zinc-200">{text.voiceLabel}</span>
          <select
            data-testid="voice-model-voice-id"
            value={currentVoiceId}
            onChange={(event) => void persistLive({ voiceId: event.target.value })}
            className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-200 outline-none focus:border-primary-500"
          >
            {conversationModelOption.voices.map((id) => (
              <option key={id} value={id}>{id}</option>
            ))}
          </select>
          <p className="text-xs text-zinc-500">{text.voiceNote}</p>
        </label>
      </div>

      {/* 转写模型：本地 whisper-cpp 模型，仅本地转写模式生效 */}
      <div className="border-t border-zinc-700 pt-4">
        <label className="block space-y-2">
          <span className="text-sm font-medium text-zinc-200">{modelText.transcriptionModelLabel}</span>
          <select
            data-testid="voice-model-transcription-model"
            value={speech.localModel}
            onChange={(event) => void persistSpeech({ localModel: event.target.value })}
            className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-200 outline-none focus:border-primary-500"
          >
            {TRANSCRIPTION_MODEL_OPTIONS.map((option) => (
              <option key={option.id} value={option.id}>{option.label}</option>
            ))}
          </select>
          <p className="text-xs text-zinc-500">{modelText.transcriptionModelNote}</p>
        </label>
      </div>
    </div>
  );
};

export default VoiceModelSettings;
