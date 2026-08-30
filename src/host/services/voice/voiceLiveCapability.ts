import type { BundledHostCapabilityDescriptor } from '../capabilities/bundledHostCapabilityRegistry';
import { resolveVoiceWorkOutcome } from './voiceWorkEvidence';
import {
  canOfferVoiceQuestion,
  cancelVoiceQuestion,
  offerVoiceQuestion,
} from './voiceQuestionBridge';

export const voiceLiveCapabilityDescriptor: BundledHostCapabilityDescriptor = {
  id: 'builtin.voice-live',
  version: '1.0.0',
  dependencies: [],
  permissions: ['microphone', 'network', 'filesystem'],
  async activate(host) {
    host.registerTurnOutcomeResolver(resolveVoiceWorkOutcome);
    host.registerUserQuestionRoute({
      canOffer: canOfferVoiceQuestion,
      offer: offerVoiceQuestion,
      cancel: cancelVoiceQuestion,
    });
    host.publishRendererCapabilityState();
    return async () => undefined;
  },
};
