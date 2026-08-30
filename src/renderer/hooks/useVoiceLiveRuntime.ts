import { useEffect, useState } from 'react';
import type { VoiceCallPhase } from '../stores/voiceCallStore';
import { useBundledCapabilityStore } from '../stores/bundledCapabilityStore';

export interface VoiceLiveRuntimeSnapshot {
  phase: VoiceCallPhase;
  sessionId: string | null;
  activeAgentId?: string;
  startedAt: number | null;
  partialUser: string;
  partialAssistant: string;
}

const EMPTY: VoiceLiveRuntimeSnapshot = {
  phase: 'idle',
  sessionId: null,
  startedAt: null,
  partialUser: '',
  partialAssistant: '',
};

function project(state: VoiceLiveRuntimeSnapshot): VoiceLiveRuntimeSnapshot {
  return {
    phase: state.phase,
    sessionId: state.sessionId,
    activeAgentId: state.activeAgentId,
    startedAt: state.startedAt,
    partialUser: state.partialUser,
    partialAssistant: state.partialAssistant,
  };
}

export function useVoiceLiveRuntime(): VoiceLiveRuntimeSnapshot {
  const installed = useBundledCapabilityStore((state) => state.installed['builtin.voice-live']);
  const [snapshot, setSnapshot] = useState<VoiceLiveRuntimeSnapshot>(EMPTY);

  useEffect(() => {
    if (!installed) {
      setSnapshot(EMPTY);
      return undefined;
    }
    let cancelled = false;
    let unsubscribe: (() => void) | undefined;
    void import('../stores/voiceCallStore').then(({ useVoiceCallStore }) => {
      if (cancelled) return;
      setSnapshot(project(useVoiceCallStore.getState()));
      unsubscribe = useVoiceCallStore.subscribe((state) => setSnapshot(project(state)));
    });
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [installed]);

  return snapshot;
}

export async function toggleInstalledVoiceCall(sessionId: string): Promise<boolean> {
  if (!useBundledCapabilityStore.getState().installed['builtin.voice-live']) return false;
  const [{ useVoiceCallStore }, { voiceCallBridge }] = await Promise.all([
    import('../stores/voiceCallStore'),
    import('../services/voiceCallBridge'),
  ]);
  if (useVoiceCallStore.getState().phase !== 'idle') voiceCallBridge.hangUp();
  else await voiceCallBridge.dial(sessionId);
  return true;
}

export async function readInstalledVoiceCall(): Promise<VoiceLiveRuntimeSnapshot> {
  if (!useBundledCapabilityStore.getState().installed['builtin.voice-live']) return EMPTY;
  const { useVoiceCallStore } = await import('../stores/voiceCallStore');
  return project(useVoiceCallStore.getState());
}
