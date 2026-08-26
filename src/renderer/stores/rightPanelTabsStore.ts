import { create } from 'zustand';

interface RightPanelTabsState {
  logsTargetTurn: number | null;
  logsTargetNonce: number;
  logsPinned: boolean;
  expertsAutoOpenedBySession: Record<string, boolean>;
  targetLogsTurn: (turn: number) => void;
  resetLogsTarget: () => void;
  setLogsPinned: (pinned: boolean) => void;
  claimExpertsAutoOpen: (sessionId: string) => boolean;
}

export const useRightPanelTabsStore = create<RightPanelTabsState>()((set, get) => ({
  logsTargetTurn: null,
  logsTargetNonce: 0,
  logsPinned: false,
  expertsAutoOpenedBySession: {},
  targetLogsTurn: (turn) => set((state) => ({
    logsTargetTurn: Math.max(1, turn),
    logsTargetNonce: state.logsTargetNonce + 1,
  })),
  resetLogsTarget: () => set((state) => ({
    logsTargetTurn: null,
    logsTargetNonce: state.logsTargetNonce + 1,
  })),
  setLogsPinned: (pinned) => set({ logsPinned: pinned }),
  claimExpertsAutoOpen: (sessionId) => {
    if (get().expertsAutoOpenedBySession[sessionId]) return false;
    set((state) => ({
      expertsAutoOpenedBySession: {
        ...state.expertsAutoOpenedBySession,
        [sessionId]: true,
      },
    }));
    return true;
  },
}));
