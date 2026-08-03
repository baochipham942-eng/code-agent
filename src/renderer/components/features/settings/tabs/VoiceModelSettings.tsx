// ============================================================================
// VoiceModelSettings - 语音模型 tab（T1 + P1，2026-07-28/31 产品负责人拍板）
//
// 「模型与能力」组收拢三处模型配置：通话 Provider / 模型 / 音色 / 转写模型。
// 使用偏好留在原 tab：实时语音（打断方式/回声消除/断句灵敏度）、语音转文字
// （转写模式/线程数等）。搬家不是复制——原 tab 不再渲染这三项。
//
// 硬约束：存储 key、默认值、读写路径一律不动——
//   voice.live.providerId / voice.live.conversationModel / voice.live.voiceId / speech.localModel，
// 且 voice.live 写入时 turnDetection 同写（运行时真源契约同 VoiceLiveSettingsSection）。
//
// P1 新增：Provider 下拉（内置 + 自定义）、Provider 级 Key 编辑、自定义 Provider
// 表单（测试通过才可保存）。不兼容鉴权/协议直接显示「需代码适配」。
// ============================================================================

import React, { useEffect, useMemo, useState } from 'react';
import { X, Plus } from 'lucide-react';
import { IPC_DOMAINS } from '@shared/ipc';
import type { AppSettings, SpeechInputSettings, CustomRealtimeVoiceProviderSettings } from '@shared/contract';
import { DEFAULT_SPEECH_INPUT_SETTINGS, VOICE_INPUT_SETTINGS_UPDATED_EVENT } from '@shared/contract';
import { VOICE_LIVE_SETTINGS_UPDATED_EVENT, type VoiceTurnDetectionConfig } from '@shared/contract/voice';
import type { VoiceLiveSettings } from '@shared/contract/settings';
import ipcService from '../../../../services/ipcService';
import { createLogger } from '../../../../utils/logger';
import { useI18n } from '../../../../hooks/useI18n';
import { deriveInterruptMode, deriveTurnDetection, deriveVadSensitivity } from '../../voice/voiceSettingsDerivation';
import { VoiceApiKeyConfig, type VoiceApiKeyCopyProfile } from './VoiceApiKeyConfig';
import { Button } from '../../../primitives';
import { toast } from '../../../../hooks/useToast';

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

// ----------------------------------------------------------------------------
// Provider list shape returned by PROVIDER domain `list_realtime_voice_providers`
// ----------------------------------------------------------------------------

interface ListedVoiceModel {
  id: string;
  displayName: string;
  supportsTools: boolean;
  voices: readonly string[];
}

interface ListedRealtimeVoiceProvider {
  id: string;
  displayName: string;
  builtIn: boolean;
  configured: boolean;
  models: readonly ListedVoiceModel[];
  defaultModel: string;
  defaultVoice: string;
  inputSampleRate: 16_000 | 24_000;
  /** custom only */
  endpoint?: string;
  authStyle?: 'bearer' | 'other';
  sessionShape?: 'openai-realtime' | 'other';
  outputSampleRate?: 16_000 | 24_000;
}

function serviceForProvider(provider: ListedRealtimeVoiceProvider): string {
  if (provider.builtIn) {
    if (provider.id === 'openai-realtime') return 'openai';
    return 'dashscope';
  }
  return `custom-realtime:${provider.id}`;
}

/** Key 说明文案 profile：与 built-in / custom provider profile 对齐，禁止跨 profile 复用 DashScope 共用说明。 */
function apiKeyCopyProfileForProvider(provider: ListedRealtimeVoiceProvider): VoiceApiKeyCopyProfile {
  if (!provider.builtIn) return 'custom';
  if (provider.id === 'openai-realtime') return 'openai';
  return 'dashscope';
}

function resolveCurrentModel(
  provider: ListedRealtimeVoiceProvider | undefined,
  conversationModel: string | undefined,
): ListedVoiceModel | undefined {
  if (!provider || provider.models.length === 0) return undefined;
  return provider.models.find((model) => model.id === conversationModel)
    ?? provider.models.find((model) => model.id === provider.defaultModel)
    ?? provider.models[0];
}

function resolveCurrentVoice(
  model: ListedVoiceModel | undefined,
  voiceId: string | undefined,
  defaultVoice: string,
): string {
  if (!model || model.voices.length === 0) return '';
  const normalizedVoiceId = voiceId ?? '';
  if (model.voices.includes(normalizedVoiceId)) return normalizedVoiceId;
  if (model.voices.includes(defaultVoice)) return defaultVoice;
  return model.voices[0];
}

const slugifyProviderId = (name: string) => {
  const s = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return s ? `custom-${s}` : '';
};

// ----------------------------------------------------------------------------
// Component
// ----------------------------------------------------------------------------

export const VoiceModelSettings: React.FC = () => {
  const { t } = useI18n();
  const text = t.voice.settings;
  const modelText = t.settings.voiceModel;

  const [live, setLive] = useState<VoiceLiveSettings>({});
  const [turnDetection, setTurnDetection] = useState<VoiceTurnDetectionConfig | undefined>(undefined);
  const [speech, setSpeech] = useState<SpeechInputSettings>(DEFAULT_SPEECH_INPUT_SETTINGS);
  const [providers, setProviders] = useState<ListedRealtimeVoiceProvider[]>([]);
  const [addProviderOpen, setAddProviderOpen] = useState(false);

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
    void ipcService.invokeDomain<ListedRealtimeVoiceProvider[]>(IPC_DOMAINS.PROVIDER, 'list_realtime_voice_providers')
      .then((list) => {
        if (cancelled) return;
        setProviders(list ?? []);
      })
      .catch((error) => logger.error('load realtime voice providers failed', error));
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

  const refreshProviders = async () => {
    try {
      const list = await ipcService.invokeDomain<ListedRealtimeVoiceProvider[]>(
        IPC_DOMAINS.PROVIDER,
        'list_realtime_voice_providers',
      );
      setProviders(list ?? []);
    } catch (error) {
      logger.error('refresh realtime voice providers failed', error);
    }
  };

  const currentProvider = useMemo(
    () => providers.find((provider) => provider.id === live.providerId) ?? providers[0],
    [providers, live.providerId],
  );

  const currentModel = resolveCurrentModel(currentProvider, live.conversationModel);
  const currentVoiceId = resolveCurrentVoice(currentModel, live.voiceId, currentProvider?.defaultVoice ?? '');

  const persistProvider = async (nextProviderId: string) => {
    const profile = providers.find((provider) => provider.id === nextProviderId);
    if (!profile) return;
    await persistLive({
      providerId: profile.id,
      conversationModel: profile.defaultModel,
      voiceId: profile.defaultVoice,
    });
  };

  const persistConversationModel = async (nextModelId: string) => {
    if (!currentProvider) return;
    const model = currentProvider.models.find((candidate) => candidate.id === nextModelId);
    if (!model) return;
    const nextVoiceId = model.voices.includes(currentVoiceId) ? currentVoiceId : model.voices[0];
    await persistLive({ conversationModel: model.id, voiceId: nextVoiceId });
  };

  const providerService = currentProvider ? serviceForProvider(currentProvider) : 'dashscope';

  return (
    <div className="space-y-6" data-testid="voice-model-settings">
      {/* Provider 下拉 + 添加自定义 Provider */}
      <div>
        <div className="flex items-center justify-between gap-4">
          <div>
            <h3 className="mb-1 text-sm font-medium text-zinc-200">{text.providerTitle}</h3>
            <p className="text-xs text-zinc-500" data-testid="voice-provider-subtitle">
              {currentProvider?.displayName ?? '-'}
            </p>
          </div>
          <span
            data-testid="voice-provider-status"
            className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] ${
              currentProvider?.configured
                ? 'bg-emerald-500/10 text-badge-success'
                : 'bg-amber-500/10 text-amber-300'
            }`}
          >
            {currentProvider?.configured
              ? text.providerConfigured
              : text.providerMissing.replace('{name}', currentProvider?.displayName ?? 'DashScope')}
          </span>
        </div>
        <div className="mt-3 flex items-center gap-2">
          <select
            data-testid="voice-provider-select"
            value={currentProvider?.id ?? ''}
            onChange={(event) => void persistProvider(event.target.value)}
            className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-200 outline-none focus:border-primary-500"
          >
            {providers.map((provider) => (
              <option key={provider.id} value={provider.id}>{provider.displayName}</option>
            ))}
          </select>
          <Button
            variant="ghost"
            size="sm"
            data-testid="voice-add-provider"
            onClick={() => setAddProviderOpen(true)}
            leftIcon={<Plus className="h-3.5 w-3.5" />}
          >
            {text.addProvider}
          </Button>
        </div>
        {addProviderOpen && (
          <AddCustomProviderPanel
            providers={providers}
            onClose={() => setAddProviderOpen(false)}
            onSaved={async (saved) => {
              // 保存结果即真相，不依赖 refreshProviders 后的 setState 才生效
              await persistLive({
                providerId: saved.id,
                conversationModel: saved.model,
                voiceId: saved.defaultVoice,
              });
              await refreshProviders();
            }}
          />
        )}
        {!currentProvider?.configured && (
          <p className="mt-2 text-xs text-amber-400/80" data-testid="voice-provider-missing-hint">
            {text.providerMissingHint.replace('{name}', currentProvider?.displayName ?? 'DashScope')}
          </p>
        )}
      </div>

      {/* API Key 常驻在语音模型 tab（批 X3 产品拍板）：key 是模型的配置，
          配没配都展示（形态不同），缺 key 引导态只是入口侧的补救通道 */}
      {currentProvider && (
        <VoiceApiKeyConfig
          key={providerService}
          provider={{
            displayName: currentProvider.displayName,
            service: providerService,
            profile: apiKeyCopyProfileForProvider(currentProvider),
          }}
          configured={currentProvider.configured}
          onKeyChanged={refreshProviders}
        />
      )}

      {/* 通话模型 / Provider：白名单可配。不支持 tools 的模型选中时当场说清代价 */}
      <div className="border-t border-zinc-700 pt-4">
        <label className="block space-y-2">
          <span className="text-sm font-medium text-zinc-200">{text.conversationModelLabel}</span>
          <select
            data-testid="voice-conversation-model"
            value={currentModel?.id ?? ''}
            onChange={(event) => void persistConversationModel(event.target.value)}
            className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-200 outline-none focus:border-primary-500"
          >
            {currentProvider?.models.map((model) => (
              <option key={model.id} value={model.id}>{model.displayName}</option>
            ))}
          </select>
          {currentModel && !currentModel.supportsTools && (
            <p data-testid="voice-model-no-tools-warning" className="text-xs text-amber-400/80">
              {text.modelNoToolsWarning}
            </p>
          )}
        </label>
      </div>

      {/* 音色：选项来自当前通话模型的实测白名单 */}
      <div className="border-t border-zinc-700 pt-4">
        <h3 className="mb-2 text-sm font-medium text-zinc-200">{text.voiceLabel}</h3>
        <div
          data-testid="voice-model-voice-list"
          className="max-h-48 overflow-auto rounded-lg border border-zinc-700 bg-zinc-900"
        >
          {currentModel?.voices.map((voice) => {
            const active = voice === currentVoiceId;
            return (
              <button
                key={voice}
                type="button"
                data-testid={`voice-model-voice-${voice}`}
                onClick={() => void persistLive({ voiceId: voice })}
                className={`flex w-full items-center gap-3 px-3 py-2 text-left text-sm transition-colors ${
                  active ? 'bg-sky-500/10 text-badge-info' : 'text-zinc-300 hover:bg-zinc-800'
                }`}
              >
                <span className="w-4 text-xs">{active ? '✓' : ''}</span>
                <span className="flex-1 font-mono">{voice}</span>
                <span className="rounded-full bg-zinc-800 px-2 py-0.5 text-[10px] text-zinc-500">
                  {text.samplePending}
                </span>
                <span
                  className="rounded border border-zinc-700 bg-zinc-950 px-2 py-0.5 text-[10px] text-zinc-500 opacity-60"
                  aria-disabled="true"
                >
                  {text.audition}
                </span>
              </button>
            );
          })}
        </div>
        <p className="mt-2 text-xs text-zinc-500">{text.voiceNote}</p>
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

// ----------------------------------------------------------------------------
// Add custom Provider button + panel
// ----------------------------------------------------------------------------

type TestStatus = 'untested' | 'testing' | 'success' | 'failed';

interface AddCustomProviderPanelProps {
  providers: ListedRealtimeVoiceProvider[];
  onClose: () => void;
  onSaved: (saved: CustomRealtimeVoiceProviderSettings) => void | Promise<void>;
}

const AddCustomProviderPanel: React.FC<AddCustomProviderPanelProps> = ({ providers, onClose, onSaved }) => {
  const { t } = useI18n();
  const text = t.voice.settings;

  const [compat, setCompat] = useState<'compatible' | 'needs-code'>('compatible');
  const [displayName, setDisplayName] = useState('');
  const [id, setId] = useState('');
  const [idTouched, setIdTouched] = useState(false);
  const [endpoint, setEndpoint] = useState('');
  const [authStyle, setAuthStyle] = useState<'bearer' | 'other'>('bearer');
  const [key, setKey] = useState('');
  const [model, setModel] = useState('');
  const [voices, setVoices] = useState('');
  const [inputSampleRate, setInputSampleRate] = useState<16_000 | 24_000>(16_000);
  const [testStatus, setTestStatus] = useState<TestStatus>('untested');
  const [testError, setTestError] = useState<string>('');
  const [testing, setTesting] = useState(false);

  interface CustomProviderCandidate {
    id: string;
    displayName: string;
    endpoint: string;
    authStyle: 'bearer' | 'other';
    sessionShape: 'openai-realtime' | 'other';
    model: string;
    voices: string[];
    defaultVoice: string;
    inputSampleRate: 16_000 | 24_000;
    outputSampleRate: 24_000;
  }

  const buildCandidate = (): CustomProviderCandidate => ({
    id: id.trim().toLowerCase(),
    displayName: displayName.trim(),
    endpoint: endpoint.trim(),
    authStyle: compat === 'needs-code' ? 'other' : authStyle,
    sessionShape: compat === 'needs-code' ? 'other' : 'openai-realtime',
    model: model.trim(),
    voices: voices.split(',').map((v) => v.trim()).filter(Boolean),
    defaultVoice: voices.split(',')[0]?.trim() ?? '',
    inputSampleRate,
    outputSampleRate: 24_000,
  });

  const resetForm = () => {
    setCompat('compatible');
    setDisplayName('');
    setId('');
    setIdTouched(false);
    setEndpoint('');
    setAuthStyle('bearer');
    setKey('');
    setModel('');
    setVoices('');
    setInputSampleRate(16_000);
    setTestStatus('untested');
    setTestError('');
  };

  const closePanel = () => {
    resetForm();
    onClose();
  };

  const invalidateTest = () => {
    if (testStatus !== 'untested') {
      setTestStatus('untested');
      setTestError('');
    }
  };

  const handleDisplayNameChange = (value: string) => {
    setDisplayName(value);
    if (!idTouched) setId(slugifyProviderId(value));
    invalidateTest();
  };

  const handleIdChange = (value: string) => {
    setId(value);
    setIdTouched(true);
    invalidateTest();
  };

  const validate = (): string | null => {
    const voiceList = voices.split(',').map((v) => v.trim()).filter(Boolean);
    if (!displayName.trim() || !id.trim() || !endpoint.trim() || !key.trim() || !model.trim() || voiceList.length === 0) {
      return text.customProviderValidationRequired;
    }
    if (providers.some((provider) => provider.id === id.trim().toLowerCase())) {
      return text.customProviderIdExists.replace('{id}', id.trim());
    }
    return null;
  };



  const handleTest = async () => {
    const candidate = buildCandidate();
    if (candidate.authStyle !== 'bearer' || candidate.sessionShape !== 'openai-realtime') {
      setTestStatus('failed');
      setTestError(text.customProviderNeedsCodeTitle);
      return;
    }
    setTesting(true);
    setTestStatus('testing');
    setTestError('');
    try {
      const result = await ipcService.invokeDomain<{ success: boolean; needsCodeAdaptation?: boolean; error?: string }>(
        IPC_DOMAINS.PROVIDER,
        'test_realtime_voice_provider',
        { provider: candidate, apiKey: key.trim() },
      );
      if (result?.success) {
        setTestStatus('success');
      } else {
        setTestStatus('failed');
        setTestError(result?.error ?? text.customProviderTestFailed);
      }
    } catch (error) {
      setTestStatus('failed');
      setTestError(error instanceof Error ? error.message : text.customProviderTestFailed);
    } finally {
      setTesting(false);
    }
  };

  const handleSave = async () => {
    if (testStatus !== 'success') return;
    const validation = validate();
    if (validation) {
      setTestError(validation);
      return;
    }
    const candidate = buildCandidate();
    if (candidate.authStyle !== 'bearer' || candidate.sessionShape !== 'openai-realtime') return;
    try {
      const saved = await ipcService.invokeDomain<CustomRealtimeVoiceProviderSettings>(
        IPC_DOMAINS.PROVIDER,
        'save_realtime_voice_provider',
        { provider: candidate, apiKey: key.trim() },
      );
      if (!saved) throw new Error('Provider save returned empty');
      toast.success(text.customProviderSaved.replace('{name}', saved.displayName));
      closePanel();
      await onSaved(saved);
    } catch (error) {
      setTestStatus('failed');
      setTestError(error instanceof Error ? error.message : text.customProviderTestFailed);
    }
  };

  return (
    <div
      data-testid="voice-add-provider-panel"
      className="mt-4 rounded-xl border border-zinc-700 bg-zinc-900/60 p-4"
    >
          <div className="mb-3 flex items-center justify-between">
            <h4 className="text-sm font-medium text-zinc-200">{text.addProviderTitle}</h4>
            <Button
              variant="ghost"
              size="sm"
              data-testid="voice-add-provider-close"
              onClick={closePanel}
              aria-label={text.addProviderClose}
              leftIcon={<X className="h-3.5 w-3.5" />}
            />
          </div>

          <div className="mb-4 grid grid-cols-2 gap-2">
            <button
              type="button"
              data-testid="voice-add-provider-compatible"
              onClick={() => { setCompat('compatible'); invalidateTest(); }}
              className={`rounded-lg border px-3 py-2 text-xs ${
                compat === 'compatible'
                  ? 'border-zinc-500 bg-zinc-800 text-zinc-200'
                  : 'border-zinc-700 text-zinc-400 hover:bg-zinc-800'
              }`}
            >
              {text.customProviderCompatible}
            </button>
            <button
              type="button"
              data-testid="voice-add-provider-needs-code"
              onClick={() => { setCompat('needs-code'); invalidateTest(); }}
              className={`rounded-lg border px-3 py-2 text-xs ${
                compat === 'needs-code'
                  ? 'border-zinc-500 bg-zinc-800 text-zinc-200'
                  : 'border-zinc-700 text-zinc-400 hover:bg-zinc-800'
              }`}
            >
              {text.customProviderNeedsCode}
            </button>
          </div>

          {compat === 'needs-code' ? (
            <div className="space-y-4">
              <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-300">
                <div className="mb-1 font-medium">{text.customProviderNeedsCodeTitle}</div>
                <p className="leading-5 text-amber-300/80">{text.customProviderNeedsCodeDesc}</p>
              </div>
              <div className="flex gap-2">
                <Button variant="primary" size="sm" disabled data-testid="voice-add-provider-save">{text.customProviderSave}</Button>
                <Button variant="ghost" size="sm" onClick={closePanel}>{text.customProviderCancel}</Button>
              </div>
            </div>
          ) : (
            <div className="space-y-3">
              <label className="block space-y-1">
                <span className="text-xs text-zinc-400">{text.customProviderDisplayNameLabel}</span>
                <input
                  data-testid="voice-add-provider-name"
                  value={displayName}
                  onChange={(e) => handleDisplayNameChange(e.target.value)}
                  placeholder={text.customProviderDisplayNamePlaceholder}
                  className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-200 outline-none focus:border-primary-500"
                />
              </label>
              <label className="block space-y-1">
                <span className="text-xs text-zinc-400">{text.customProviderIdLabel}</span>
                <input
                  data-testid="voice-add-provider-id"
                  value={id}
                  onChange={(e) => handleIdChange(e.target.value)}
                  placeholder={text.customProviderIdPlaceholder}
                  className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm font-mono text-zinc-200 outline-none focus:border-primary-500"
                />
                <span className="text-[11px] text-zinc-500">{text.customProviderIdHint}</span>
              </label>
              <label className="block space-y-1">
                <span className="text-xs text-zinc-400">{text.customProviderEndpointLabel}</span>
                <input
                  data-testid="voice-add-provider-endpoint"
                  value={endpoint}
                  onChange={(e) => { setEndpoint(e.target.value); invalidateTest(); }}
                  placeholder={text.customProviderEndpointPlaceholder}
                  className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm font-mono text-zinc-200 outline-none focus:border-primary-500"
                />
              </label>
              <label className="block space-y-1">
                <span className="text-xs text-zinc-400">{text.customProviderAuthLabel}</span>
                <select
                  data-testid="voice-add-provider-auth"
                  value={authStyle}
                  onChange={(e) => {
                    const value = e.target.value as 'bearer' | 'other';
                    setAuthStyle(value);
                    if (value === 'other') setCompat('needs-code');
                    invalidateTest();
                  }}
                  className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-200 outline-none focus:border-primary-500"
                >
                  <option value="bearer">{text.customProviderAuthBearer}</option>
                  <option value="other">{text.customProviderAuthOther}</option>
                </select>
              </label>
              <label className="block space-y-1">
                <span className="text-xs text-zinc-400">{text.customProviderKeyLabel}</span>
                <input
                  type="password"
                  data-testid="voice-add-provider-key"
                  value={key}
                  onChange={(e) => { setKey(e.target.value); invalidateTest(); }}
                  placeholder={text.customProviderKeyPlaceholder}
                  className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm font-mono text-zinc-200 outline-none focus:border-primary-500"
                />
                <span className="text-[11px] text-zinc-500">{text.customProviderKeyHint}</span>
              </label>
              <label className="block space-y-1">
                <span className="text-xs text-zinc-400">{text.customProviderModelLabel}</span>
                <input
                  data-testid="voice-add-provider-model"
                  value={model}
                  onChange={(e) => { setModel(e.target.value); invalidateTest(); }}
                  placeholder={text.customProviderModelPlaceholder}
                  className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm font-mono text-zinc-200 outline-none focus:border-primary-500"
                />
              </label>
              <label className="block space-y-1">
                <span className="text-xs text-zinc-400">{text.customProviderVoicesLabel}</span>
                <input
                  data-testid="voice-add-provider-voices"
                  value={voices}
                  onChange={(e) => { setVoices(e.target.value); invalidateTest(); }}
                  placeholder={text.customProviderVoicesPlaceholder}
                  className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-200 outline-none focus:border-primary-500"
                />
                <span className="text-[11px] text-zinc-500">{text.customProviderVoicesHint}</span>
              </label>
              <label className="block space-y-1">
                <span className="text-xs text-zinc-400">{text.customProviderSampleRateLabel}</span>
                <select
                  data-testid="voice-add-provider-rate"
                  value={inputSampleRate}
                  onChange={(e) => { setInputSampleRate(Number(e.target.value) as 16_000 | 24_000); invalidateTest(); }}
                  className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-200 outline-none focus:border-primary-500"
                >
                  <option value={16_000}>{text.customProviderSampleRate16k}</option>
                  <option value={24_000}>{text.customProviderSampleRate24k}</option>
                </select>
                <span className="text-[11px] text-zinc-500">{text.customProviderSampleRateHint}</span>
              </label>

              <div className="flex items-center gap-3 border-t border-zinc-700 pt-3">
                <Button
                  variant="ghost"
                  size="sm"
                  data-testid="voice-add-provider-test"
                  onClick={() => void handleTest()}
                  disabled={testing}
                >
                  {testing ? text.customProviderTesting : text.customProviderTest}
                </Button>
                <span data-testid="voice-add-provider-test-status">
                  {testStatus === 'untested' && <span className="rounded-full bg-zinc-800 px-2 py-0.5 text-[11px] text-zinc-400">{text.untestedBadge}</span>}
                  {testStatus === 'testing' && <span className="text-[11px] text-zinc-400">{text.customProviderTesting}</span>}
                  {testStatus === 'success' && <span className="rounded-full bg-emerald-500/10 px-2 py-0.5 text-[11px] text-badge-success">{text.customProviderTestSuccess}</span>}
                  {testStatus === 'failed' && <span className="rounded-full bg-rose-500/10 px-2 py-0.5 text-[11px] text-rose-300">{text.customProviderTestFailed}</span>}
                </span>
              </div>
              <p className="text-[11px] text-zinc-500" data-testid="voice-add-provider-test-hint">
                {testError
                  ? testError
                  : testStatus === 'untested'
                    ? text.customProviderTestHintUntested
                    : testStatus === 'testing'
                      ? text.customProviderTestHintTesting
                      : testStatus === 'success'
                        ? text.customProviderTestHintSuccess
                        : text.customProviderTestHintFailed}
              </p>

              <div className="flex gap-2">
                <Button
                  variant="primary"
                  size="sm"
                  data-testid="voice-add-provider-save"
                  onClick={() => void handleSave()}
                  disabled={testStatus !== 'success'}
                >
                  {text.customProviderSave}
                </Button>
                <Button variant="ghost" size="sm" onClick={closePanel}>{text.customProviderCancel}</Button>
              </div>
            </div>
          )}
        </div>
  );
};

export default VoiceModelSettings;
