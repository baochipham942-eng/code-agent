import { createHash } from 'node:crypto';

import { REALTIME_VOICE_PROVIDER_PROFILES } from '../../../src/shared/constants/realtimeVoiceProviders';
import { buildSessionUpdate } from '../../../src/host/services/voice/realtimeSessionConfig';
import {
  buildVoiceTurnPrompt,
  detectVoiceReceptionAmbiguity,
  resolveVoiceRouting,
} from '../../../src/host/services/voice/voiceRouting';
import { VOICE_TOOL_DEFINITIONS } from '../../../src/host/services/voice/voiceTools';

export function resolveProductionVoiceEvalConfig() {
  const profile = REALTIME_VOICE_PROVIDER_PROFILES['dashscope-qwen-omni'];
  const instructions = resolveVoiceRouting().personaInstructions;
  const tools = VOICE_TOOL_DEFINITIONS;
  const sessionUpdate = buildSessionUpdate(profile, {
    model: profile.defaultModel,
    voice: profile.defaultVoice,
    instructions,
    tools,
    turnDetection: null,
  });
  const fingerprint = createHash('sha256')
    .update(JSON.stringify({ instructions, tools, sessionUpdate }))
    .digest('hex');
  return {
    profile,
    instructions,
    tools,
    sessionUpdate,
    fingerprint,
    buildVoiceTurnPrompt,
    detectVoiceReceptionAmbiguity,
  };
}
