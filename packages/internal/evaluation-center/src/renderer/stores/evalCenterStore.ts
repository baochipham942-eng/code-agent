import { create } from 'zustand';

export type EvalCenterTab = 'replay' | 'validation' | 'telemetry' | 'cases' | 'scorers' | 'benchmarks';

interface EvalCenterState {
  tab: EvalCenterTab;
  replaySessionId: string | null;
  focusCaseId: string | null;
  setTab: (tab: EvalCenterTab) => void;
  openReplay: (sessionId?: string | null) => void;
  openCase: (caseId: string) => void;
  clearReplayTarget: () => void;
  clearCaseTarget: () => void;
}

export const useEvalCenterStore = create<EvalCenterState>((set) => ({
  tab: 'replay',
  replaySessionId: null,
  focusCaseId: null,
  setTab: (tab) => set({ tab }),
  openReplay: (replaySessionId) => set({ tab: 'replay', replaySessionId: replaySessionId ?? null }),
  openCase: (focusCaseId) => set({ tab: 'cases', focusCaseId }),
  clearReplayTarget: () => set({ replaySessionId: null }),
  clearCaseTarget: () => set({ focusCaseId: null }),
}));
