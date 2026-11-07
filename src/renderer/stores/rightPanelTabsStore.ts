import { create } from 'zustand';

interface RightPanelTabsState {
  logsTargetTurn: number | null;
  logsTargetNonce: number;
  logsPinned: boolean;
  targetLogsTurn: (turn: number) => void;
  resetLogsTarget: () => void;
  setLogsPinned: (pinned: boolean) => void;
}

export const useRightPanelTabsStore = create<RightPanelTabsState>()((set) => ({
  logsTargetTurn: null,
  logsTargetNonce: 0,
  logsPinned: false,
  targetLogsTurn: (turn) => set((state) => ({
    logsTargetTurn: Math.max(1, turn),
    logsTargetNonce: state.logsTargetNonce + 1,
  })),
  resetLogsTarget: () => set((state) => ({
    logsTargetTurn: null,
    logsTargetNonce: state.logsTargetNonce + 1,
  })),
  setLogsPinned: (pinned) => set({ logsPinned: pinned }),
}));
