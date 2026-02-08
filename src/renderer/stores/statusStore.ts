// ============================================================================
// Status Store - Agent 运行状态追踪
// ============================================================================
// 用于 StatusBar 显示：模型、Token、费用、上下文、网络、Git 等信息

import { create } from 'zustand';

export type NetworkStatus = 'online' | 'offline' | 'slow';

interface StatusState {
  // Token 使用
  inputTokens: number;
  outputTokens: number;

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

  // Streaming
  isStreaming: boolean;

  // Actions
  updateTokens: (input: number, output: number) => void;
  addCost: (cost: number) => void;
  resetSession: () => void;
  setContextUsage: (percent: number) => void;
  setNetworkStatus: (status: NetworkStatus) => void;
  setGitInfo: (branch: string | null, dir: string | null) => void;
  setStreaming: (streaming: boolean) => void;
}

export const useStatusStore = create<StatusState>((set) => ({
  inputTokens: 0,
  outputTokens: 0,
  sessionCost: 0,
  contextUsagePercent: 0,
  sessionStartTime: Date.now(),
  networkStatus: 'online',
  gitBranch: null,
  workingDirectory: null,
  isStreaming: false,

  updateTokens: (input, output) =>
    set((state) => ({
      inputTokens: state.inputTokens + input,
      outputTokens: state.outputTokens + output,
    })),

  addCost: (cost) =>
    set((state) => ({
      sessionCost: state.sessionCost + cost,
    })),

  resetSession: () =>
    set({
      inputTokens: 0,
      outputTokens: 0,
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

  setStreaming: (streaming) =>
    set({ isStreaming: streaming }),
}));
