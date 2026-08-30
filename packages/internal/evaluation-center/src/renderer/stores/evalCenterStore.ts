import { create } from 'zustand';

export type EvalCenterTab = 'replay' | 'validation' | 'telemetry' | 'cases' | 'scorers' | 'benchmarks';

interface EvalCenterState {
  tab: EvalCenterTab;
  replaySessionId: string | null;
  setTab: (tab: EvalCenterTab) => void;
  openReplay: (sessionId?: string | null) => void;
  clearReplayTarget: () => void;
}

export const useEvalCenterStore = create<EvalCenterState>((set) => ({
  tab: 'replay',
  replaySessionId: null,
  setTab: (tab) => set({ tab }),
  openReplay: (replaySessionId) => set({ tab: 'replay', replaySessionId: replaySessionId ?? null }),
  clearReplayTarget: () => set({ replaySessionId: null }),
}));
