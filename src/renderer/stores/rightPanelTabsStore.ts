import { create } from 'zustand';

interface RightPanelTabsState {
  logsTargetTurn: number | null;
  logsTargetNonce: number;
  logsPinned: boolean;
  expertsDismissedBySession: Record<string, boolean>;
  targetLogsTurn: (turn: number) => void;
  resetLogsTarget: () => void;
  setLogsPinned: (pinned: boolean) => void;
  setExpertsDismissed: (sessionId: string, dismissed: boolean) => void;
}

export const useRightPanelTabsStore = create<RightPanelTabsState>()((set) => ({
  logsTargetTurn: null,
  logsTargetNonce: 0,
  logsPinned: false,
  expertsDismissedBySession: {},
  targetLogsTurn: (turn) => set((state) => ({
    logsTargetTurn: Math.max(1, turn),
    logsTargetNonce: state.logsTargetNonce + 1,
  })),
  resetLogsTarget: () => set((state) => ({
    logsTargetTurn: null,
    logsTargetNonce: state.logsTargetNonce + 1,
  })),
  setLogsPinned: (pinned) => set({ logsPinned: pinned }),
  setExpertsDismissed: (sessionId, dismissed) => set((state) => ({
    expertsDismissedBySession: {
      ...state.expertsDismissedBySession,
      [sessionId]: dismissed,
    },
  })),
}));
