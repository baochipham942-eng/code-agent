// ============================================================================
// Status Store - Agent 运行状态追踪
// ============================================================================
// 用于 StatusBar 显示：模型、Token、费用、上下文、网络、Git 等信息

import { create } from 'zustand';

export type NetworkStatus = 'online' | 'offline' | 'slow';

interface StatusState {
  // 费用
  sessionCost: number;

  // 上下文
  contextUsagePercent: number;

  // 会话
  sessionStartTime: number;

  // 网络
  networkStatus: NetworkStatus;

  // Git
  gitBranch: string | null;
  workingDirectory: string | null;
  gitChanges: { staged: number; unstaged: number; untracked: number } | null;

  // Streaming
  isStreaming: boolean;

  // Actions
  addCost: (cost: number) => void;
  resetSession: () => void;
  setContextUsage: (percent: number) => void;
  setNetworkStatus: (status: NetworkStatus) => void;
  setGitInfo: (branch: string | null, dir: string | null) => void;
  setGitChanges: (changes: { staged: number; unstaged: number; untracked: number } | null) => void;
  setStreaming: (streaming: boolean) => void;
}

export const useStatusStore = create<StatusState>((set) => ({
  sessionCost: 0,
  contextUsagePercent: 0,
  sessionStartTime: Date.now(),
  networkStatus: 'online',
  gitBranch: null,
  workingDirectory: null,
  gitChanges: null,
  isStreaming: false,

  addCost: (cost) =>
    set((state) => ({
      sessionCost: state.sessionCost + cost,
    })),

  resetSession: () =>
    set({
      sessionCost: 0,
      sessionStartTime: Date.now(),
      contextUsagePercent: 0,
    }),

  setContextUsage: (percent) =>
    set({ contextUsagePercent: percent }),

  setNetworkStatus: (status) =>
    set({ networkStatus: status }),

  setGitInfo: (branch, dir) =>
    set({ gitBranch: branch, workingDirectory: dir }),

  setGitChanges: (changes) =>
    set({ gitChanges: changes }),

  setStreaming: (streaming) =>
    set({ isStreaming: streaming }),
}));
