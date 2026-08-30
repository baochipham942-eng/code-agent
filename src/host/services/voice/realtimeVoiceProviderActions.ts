import { REALTIME_VOICE_PROVIDER_PROFILES } from '../../../shared/constants/realtimeVoiceProviders';
import type { IPCResponse } from '../../../shared/ipc';
import type { HostProviderActionContribution } from '../capabilities/hostCapabilityContributions';
import { getDashscopeApiKey } from '../media/imageGenerationService';
import {
  deleteCustomRealtimeVoiceProvider,
  getRealtimeVoiceProviderApiKey,
  hasCustomRealtimeVoiceProviderApiKey,
  listCustomRealtimeVoiceProviders,
  saveCustomRealtimeVoiceProvider,
  testCustomRealtimeVoiceProvider,
  type CustomRealtimeVoiceProviderInput,
} from './customRealtimeVoiceProviders';

const ACTIONS = [
  'list_realtime_voice_providers',
  'test_realtime_voice_provider',
  'save_realtime_voice_provider',
  'delete_realtime_voice_provider',
] as const;

export function createRealtimeVoiceProviderActionContribution(): HostProviderActionContribution {
  return {
    actions: ACTIONS,
    async handle(action, payload): Promise<IPCResponse> {
      if (action === 'list_realtime_voice_providers') {
        const builtins = Object.values(REALTIME_VOICE_PROVIDER_PROFILES).map((profile) => ({
          id: profile.id,
          displayName: profile.displayName,
          builtIn: true,
          configured: profile.id === 'dashscope-qwen-omni'
            ? Boolean(getDashscopeApiKey())
            : Boolean(getRealtimeVoiceProviderApiKey(profile)),
          models: profile.models,
          defaultModel: profile.defaultModel,
          defaultVoice: profile.defaultVoice,
          inputSampleRate: profile.inputSampleRate,
        }));
        const custom = listCustomRealtimeVoiceProviders().map((provider) => ({
          ...provider,
          builtIn: false,
          configured: hasCustomRealtimeVoiceProviderApiKey(provider.id),
        }));
        return { success: true, data: [...builtins, ...custom] };
      }
      if (action === 'test_realtime_voice_provider') {
        const candidate = payload as { provider: CustomRealtimeVoiceProviderInput; apiKey: string };
        return { success: true, data: await testCustomRealtimeVoiceProvider(candidate.provider, candidate.apiKey) };
      }
      if (action === 'save_realtime_voice_provider') {
        const candidate = payload as { provider: CustomRealtimeVoiceProviderInput; apiKey: string };
        return { success: true, data: await saveCustomRealtimeVoiceProvider(candidate.provider, candidate.apiKey) };
      }
      const id = (payload as { id?: unknown } | undefined)?.id;
      if (typeof id !== 'string') {
        return { success: false, error: { code: 'INVALID_ARGUMENT', message: 'Provider ID is required.' } };
      }
      await deleteCustomRealtimeVoiceProvider(id);
      return { success: true, data: { ok: true } };
    },
  };
}
