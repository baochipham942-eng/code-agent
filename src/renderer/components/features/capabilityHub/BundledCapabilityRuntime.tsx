import React from 'react';
import { useBundledCapabilityBootstrap } from '../../../hooks/useBundledCapabilityBootstrap';
import { useBundledCapabilityStore } from '../../../stores/bundledCapabilityStore';

const VoicePasteIndicator = React.lazy(() => import('../voice/VoicePasteIndicator').then((module) => ({
  default: module.VoicePasteIndicator,
})));

export const BundledCapabilityRuntime: React.FC = () => {
  useBundledCapabilityBootstrap();
  const voiceInputInstalled = useBundledCapabilityStore(
    (state) => state.installed['builtin.voice-input'],
  );
  if (!voiceInputInstalled) return null;
  return (
    <React.Suspense fallback={null}>
      <VoicePasteIndicator />
    </React.Suspense>
  );
};
