import type { ModelProvider } from '../contract/model';
import type { CustomRealtimeVoiceProviderSettings } from '../contract/settings';
import type { VoiceTurnDetectionConfig } from '../contract/voice';
import {
  QWEN_OMNI_REALTIME_MODEL,
  QWEN_OMNI_REALTIME_MODEL_OPTIONS,
  QWEN_OMNI_REALTIME_TRANSCRIPTION_MODEL,
  QWEN_OMNI_REALTIME_VOICE,
  QWEN_OMNI_REALTIME_WS_URL,
} from './voice';

export type BuiltInRealtimeVoiceProviderId = 'dashscope-qwen-omni' | 'openai-realtime';
export type RealtimeVoiceProviderId = BuiltInRealtimeVoiceProviderId | (string & {});
export type RealtimeSessionShape = 'dashscope-compatible' | 'openai-realtime';

export interface RealtimeVoiceModelProfile {
  id: string;
  displayName: string;
  supportsTools: boolean;
  voices: readonly string[];
}

export interface RealtimeVoiceProviderProfile {
  id: string;
  displayName: string;
  keyProvider: ModelProvider;
  authStyle: 'bearer';
  sessionShape: RealtimeSessionShape;
  wsUrl: (model: string) => string;
  models: readonly RealtimeVoiceModelProfile[];
  defaultModel: string;
  defaultVoice: string;
  inputSampleRate: 16_000 | 24_000;
  outputSampleRate: 24_000;
  transcriptionModel?: string;
  needsProxy: boolean;
  turnDetection: {
    supportsServerVad: boolean;
    supportsSemanticVad: boolean;
  };
  /**
   * 探针能力只描述证据边界，不直接生成 UI。
   * OpenAI 官方协议明确首段音频后不能换 voice；DashScope 仍需真合成探针。
   */
  probes: {
    voiceSwitch: 'before-first-audio-only' | 'unverified';
    upstreamHotwords: 'unverified';
  };
}

const OPENAI_REALTIME_VOICES = [
  'marin',
  'cedar',
  'alloy',
  'ash',
  'ballad',
  'coral',
  'echo',
  'sage',
  'shimmer',
  'verse',
] as const;

const DASH_SCOPE_PROFILE: RealtimeVoiceProviderProfile = {
  id: 'dashscope-qwen-omni',
  displayName: 'DashScope Qwen Omni',
  keyProvider: 'qwen',
  authStyle: 'bearer',
  sessionShape: 'dashscope-compatible',
  wsUrl: (model) => `${QWEN_OMNI_REALTIME_WS_URL}?model=${encodeURIComponent(model)}`,
  models: QWEN_OMNI_REALTIME_MODEL_OPTIONS.map((model) => ({
    id: model.id,
    displayName: model.id,
    supportsTools: model.supportsTools,
    voices: model.voices,
  })),
  defaultModel: QWEN_OMNI_REALTIME_MODEL,
  defaultVoice: QWEN_OMNI_REALTIME_VOICE,
  inputSampleRate: 16_000,
  outputSampleRate: 24_000,
  transcriptionModel: QWEN_OMNI_REALTIME_TRANSCRIPTION_MODEL,
  needsProxy: false,
  turnDetection: {
    supportsServerVad: true,
    supportsSemanticVad: true,
  },
  probes: {
    voiceSwitch: 'unverified',
    upstreamHotwords: 'unverified',
  },
};

const OPENAI_PROFILE: RealtimeVoiceProviderProfile = {
  id: 'openai-realtime',
  displayName: 'OpenAI Realtime',
  keyProvider: 'openai',
  authStyle: 'bearer',
  sessionShape: 'openai-realtime',
  wsUrl: (model) => `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(model)}`,
  models: [
    {
      id: 'gpt-realtime-2.1',
      displayName: 'GPT Realtime 2.1',
      supportsTools: true,
      voices: OPENAI_REALTIME_VOICES,
    },
    {
      id: 'gpt-realtime-2.1-mini',
      displayName: 'GPT Realtime 2.1 mini',
      supportsTools: true,
      voices: OPENAI_REALTIME_VOICES,
    },
  ],
  defaultModel: 'gpt-realtime-2.1',
  defaultVoice: 'marin',
  inputSampleRate: 24_000,
  outputSampleRate: 24_000,
  transcriptionModel: 'gpt-realtime-whisper',
  needsProxy: true,
  turnDetection: {
    supportsServerVad: true,
    supportsSemanticVad: true,
  },
  probes: {
    voiceSwitch: 'before-first-audio-only',
    upstreamHotwords: 'unverified',
  },
};

export const REALTIME_VOICE_PROVIDER_PROFILES = {
  'dashscope-qwen-omni': DASH_SCOPE_PROFILE,
  'openai-realtime': OPENAI_PROFILE,
} as const satisfies Record<BuiltInRealtimeVoiceProviderId, RealtimeVoiceProviderProfile>;

export const DEFAULT_REALTIME_VOICE_PROVIDER_ID: BuiltInRealtimeVoiceProviderId = 'dashscope-qwen-omni';

export function resolveRealtimeVoiceProviderId(value: unknown): BuiltInRealtimeVoiceProviderId {
  if (value === 'openai-realtime') return value;
  return DEFAULT_REALTIME_VOICE_PROVIDER_ID;
}

export function getBuiltInRealtimeVoiceProfile(value: unknown): RealtimeVoiceProviderProfile | null {
  if (value !== 'dashscope-qwen-omni' && value !== 'openai-realtime') return null;
  return REALTIME_VOICE_PROVIDER_PROFILES[value];
}

export function resolveRealtimeVoiceProfile(value: unknown): RealtimeVoiceProviderProfile {
  return REALTIME_VOICE_PROVIDER_PROFILES[resolveRealtimeVoiceProviderId(value)];
}

function customRealtimeWsUrl(endpoint: string, model: string): string {
  const url = new URL(endpoint);
  if (!url.searchParams.has('model')) url.searchParams.set('model', model);
  return url.toString();
}

export function createCustomRealtimeVoiceProfile(
  provider: CustomRealtimeVoiceProviderSettings,
): RealtimeVoiceProviderProfile {
  return {
    id: provider.id,
    displayName: provider.displayName,
    keyProvider: `custom-realtime:${provider.id}`,
    authStyle: 'bearer',
    sessionShape: 'openai-realtime',
    wsUrl: (model) => customRealtimeWsUrl(provider.endpoint, model),
    models: [{
      id: provider.model,
      displayName: provider.model,
      supportsTools: true,
      voices: provider.voices,
    }],
    defaultModel: provider.model,
    defaultVoice: provider.defaultVoice,
    inputSampleRate: provider.inputSampleRate,
    outputSampleRate: provider.outputSampleRate,
    needsProxy: true,
    turnDetection: {
      supportsServerVad: true,
      supportsSemanticVad: true,
    },
    probes: {
      voiceSwitch: 'unverified',
      upstreamHotwords: 'unverified',
    },
  };
}

export function resolveRealtimeVoiceSelection(
  provider: RealtimeVoiceProviderProfile,
  modelId: string | undefined,
  voiceId: string | undefined,
): { model: RealtimeVoiceModelProfile; voice: string } {
  const model = provider.models.find((candidate) => candidate.id === modelId)
    ?? provider.models.find((candidate) => candidate.id === provider.defaultModel)
    ?? provider.models[0];
  const voice = voiceId && model.voices.includes(voiceId)
    ? voiceId
    : model.voices.includes(provider.defaultVoice)
      ? provider.defaultVoice
      : model.voices[0];
  return { model, voice };
}

export function supportsTurnDetection(
  profile: RealtimeVoiceProviderProfile,
  config: VoiceTurnDetectionConfig,
): boolean {
  if (config === null) return true;
  return config.type === 'semantic_vad'
    ? profile.turnDetection.supportsSemanticVad
    : profile.turnDetection.supportsServerVad;
}
