import type { BundledHostCapabilityDescriptor } from '../capabilities/bundledHostCapabilityRegistry';
import { configureSpeechHandlers, registerSpeechHandlers } from '../../ipc/speech.ipc';
import {
  hasActiveVoicePaste,
  registerVoicePasteHandlers,
  registerVoicePasteShortcut,
  configureVoicePasteTranscription,
} from '../../ipc/voicePaste.ipc';
import { createDictationStreamUpgradeContribution } from '../../../web/dictationStreamUpgrade';
import { hasActiveDictationStream } from './dictationStreamService';
import { hasActiveSpeechTranscription } from './speechTranscriptionService';
import { clearRetainedSpeechAudio, getSpeechTranscriptionService } from './speechTranscriptionService';
import { attachDictationClient } from './dictationStreamService';
import { createVoiceInputWebRouteContribution } from './voiceInputWebContribution';

export const voiceInputCapabilityDescriptor: BundledHostCapabilityDescriptor = {
  id: 'builtin.voice-input',
  version: '1.0.0',
  dependencies: [],
  permissions: ['microphone', 'network', 'clipboard', 'accessibility', 'shell'],
  beforeUninstall() {
    if (hasActiveDictationStream() || hasActiveSpeechTranscription() || hasActiveVoicePaste()) {
      throw new Error('语音输入正在录音或转写，请结束当前听写后再卸载。');
    }
  },
  async activate(host) {
    const transcribe = getSpeechTranscriptionService().transcribe.bind(getSpeechTranscriptionService());
    const cleanupSpeechConfig = configureSpeechHandlers({
      transcribe,
      clearRetainedAudio: clearRetainedSpeechAudio,
    });
    const cleanupPasteConfig = configureVoicePasteTranscription(transcribe);
    host.registerIpcHandler(registerSpeechHandlers);
    host.registerIpcHandler(registerVoicePasteHandlers);
    host.registerWebRoute(createVoiceInputWebRouteContribution());
    host.registerWebSocketUpgrade(createDictationStreamUpgradeContribution(attachDictationClient));
    host.registerShortcut(registerVoicePasteShortcut);
    host.publishRendererCapabilityState();
    return async () => {
      await cleanupPasteConfig();
      await cleanupSpeechConfig();
    };
  },
};
