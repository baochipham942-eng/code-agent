import type { BundledHostCapabilityDescriptor } from '../capabilities/bundledHostCapabilityRegistry';
import { registerSpeechHandlers } from '../../ipc/speech.ipc';
import {
  hasActiveVoicePaste,
  registerVoicePasteHandlers,
  registerVoicePasteShortcut,
} from '../../ipc/voicePaste.ipc';
import { createDictationStreamUpgradeContribution } from '../../../web/dictationStreamUpgrade';
import { hasActiveDictationStream } from './dictationStreamService';
import { hasActiveSpeechTranscription } from './speechTranscriptionService';

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
    host.registerIpcHandler(registerSpeechHandlers);
    host.registerIpcHandler(registerVoicePasteHandlers);
    host.registerWebSocketUpgrade(createDictationStreamUpgradeContribution());
    host.registerShortcut(registerVoicePasteShortcut);
    host.publishRendererCapabilityState();
    return async () => undefined;
  },
};
