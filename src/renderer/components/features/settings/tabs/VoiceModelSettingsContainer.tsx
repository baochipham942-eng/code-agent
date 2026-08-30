import React from 'react';
import { useBundledCapabilityStore } from '../../../../stores/bundledCapabilityStore';

const LiveVoiceModelSettings = React.lazy(() => import('./VoiceModelSettings'));
const VoiceInputModelSettings = React.lazy(() => import('./VoiceInputModelSettings'));

const VoiceModelSettingsContainer: React.FC = () => {
  const liveInstalled = useBundledCapabilityStore((state) => state.installed['builtin.voice-live']);
  const inputInstalled = useBundledCapabilityStore((state) => state.installed['builtin.voice-input']);

  if (!liveInstalled && !inputInstalled) return null;
  return (
    <React.Suspense fallback={null}>
      {liveInstalled ? <LiveVoiceModelSettings /> : <VoiceInputModelSettings />}
    </React.Suspense>
  );
};

export default VoiceModelSettingsContainer;
