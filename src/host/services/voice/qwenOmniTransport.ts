import { REALTIME_VOICE_PROVIDER_PROFILES } from '../../../shared/constants/realtimeVoiceProviders';
import { createRealtimeTransport } from './realtimeTransport';

/**
 * 兼容旧 import；实现已收敛到通用 realtime transport。
 * 新调用方应按 provider profile 选择 transport。
 */
export const qwenOmniTransport = createRealtimeTransport(
  REALTIME_VOICE_PROVIDER_PROFILES['dashscope-qwen-omni'],
);
