import type { BundledHostCapabilityDescriptor } from '../capabilities/bundledHostCapabilityRegistry';
import { resolveVoiceWorkOutcome } from './voiceWorkEvidence';
import {
  canOfferVoiceQuestion,
  cancelVoiceQuestion,
  offerVoiceQuestion,
} from './voiceQuestionBridge';
import { createLogger } from '../infra/logger';
import { registerVoiceHandlers } from './voiceIpcContribution';
import { createRealtimeVoiceProviderActionContribution } from './realtimeVoiceProviderActions';
import { createVoiceStreamUpgradeContribution, createVoiceWebRouteContribution } from './voiceWebContributions';
import { hasActiveVoiceCall, refreshVoiceInstructions } from './voiceSessionService';
import { runVoiceRecordingRetention } from './voiceRecordingRetention';

const logger = createLogger('VoiceLiveCapability');

export const voiceLiveCapabilityDescriptor: BundledHostCapabilityDescriptor = {
  id: 'builtin.voice-live',
  version: '1.0.0',
  dependencies: [],
  permissions: ['microphone', 'network', 'filesystem'],
  beforeUninstall() {
    if (hasActiveVoiceCall()) {
      throw new Error('实时通话或录音正在进行，请先结束通话再卸载。');
    }
  },
  async activate(host) {
    host.registerIpcHandler(registerVoiceHandlers);
    host.registerWebRoute(createVoiceWebRouteContribution());
    host.registerWebSocketUpgrade(createVoiceStreamUpgradeContribution());
    host.registerStartupTask(() => {
      void runVoiceRecordingRetention()
        .catch((error) => logger.warn('Voice recording retention failed (non-blocking):', (error as Error).message));
      return () => undefined;
    });
    host.registerProviderAction(createRealtimeVoiceProviderActionContribution());
    host.registerTurnOutcomeResolver(resolveVoiceWorkOutcome);
    host.registerUserQuestionRoute({
      canOffer: canOfferVoiceQuestion,
      offer: offerVoiceQuestion,
      cancel: cancelVoiceQuestion,
    });
    host.registerVoiceInstructionsRefresher(refreshVoiceInstructions);
    host.publishRendererCapabilityState();
    return async () => undefined;
  },
};
