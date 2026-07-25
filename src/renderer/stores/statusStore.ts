// ============================================================================
// Status Store - Agent 运行状态追踪
// ============================================================================
// 用于 StatusBar 显示：模型、Token、费用、上下文、网络、Git 等信息

import { create } from 'zustand';
import {
  estimateTurnCostUsd,
  resolveModelPrice,
  type PriceSource,
} from '@shared/pricing/resolveModelPrice';

export type NetworkStatus = 'online' | 'offline' | 'slow';

/** 本轮费用估算（设计稿 §5.4；usd=null 表示该模型无刊例价，禁止显示假数字） */
export interface TurnCostInfo {
  usd: number | null;
  source: PriceSource;
  modelId: string;
  inputTokens: number;
  outputTokens: number;
}

interface StatusState {
  // 费用
  sessionCost: number;
  lastTurnCost: TurnCostInfo | null;
  /** 无刊例价被跳过记账的轮数（tooltip 提示「N 轮未知价未计入」） */
  unknownCostTurns: number;
  /** model_decision 记录的本轮实际模型（stream_usage 事件不带模型，靠它归因） */
  currentTurnModel: { provider: string; model: string } | null;

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
  setCurrentTurnModel: (model: { provider: string; model: string } | null) => void;
  recordTurnUsage: (usage: { inputTokens: number; outputTokens: number }) => void;
  resetSession: () => void;
  setContextUsage: (percent: number) => void;
  setNetworkStatus: (status: NetworkStatus) => void;
  setGitInfo: (branch: string | null, dir: string | null) => void;
  setGitChanges: (changes: { staged: number; unstaged: number; untracked: number } | null) => void;
  setStreaming: (streaming: boolean) => void;
}

export const useStatusStore = create<StatusState>((set) => ({
  sessionCost: 0,
  lastTurnCost: null,
  unknownCostTurns: 0,
  currentTurnModel: null,
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

  setCurrentTurnModel: (model) =>
    set({ currentTurnModel: model }),

  // stream_usage 事件 → 按刊例估算本轮费用。无刊例价（source=unknown）时不累计、
  // 不编造金额，只记未知轮数（设计稿 §6.3：今日合计标注「N 轮未知价未计入」）。
  recordTurnUsage: (usage) =>
    set((state) => {
      const model = state.currentTurnModel;
      const price = model
        ? resolveModelPrice(model.provider, model.model)
        : { modelId: 'unknown', source: 'unknown' as const };
      const usd = estimateTurnCostUsd(price, usage);
      return {
        lastTurnCost: {
          usd,
          source: price.source,
          modelId: model?.model ?? 'unknown',
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
        },
        sessionCost: state.sessionCost + (usd ?? 0),
        unknownCostTurns: state.unknownCostTurns + (usd === null ? 1 : 0),
      };
    }),

  resetSession: () =>
    set({
      sessionCost: 0,
      lastTurnCost: null,
      unknownCostTurns: 0,
      currentTurnModel: null,
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
