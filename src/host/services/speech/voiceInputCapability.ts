import type { BundledHostCapabilityDescriptor } from '../capabilities/bundledHostCapabilityRegistry';

export const voiceInputCapabilityDescriptor: BundledHostCapabilityDescriptor = {
  id: 'builtin.voice-input',
  version: '1.0.0',
  dependencies: [],
  permissions: ['microphone', 'network', 'clipboard', 'accessibility', 'shell'],
  async activate(host) {
    host.publishRendererCapabilityState();
    return async () => undefined;
  },
};
