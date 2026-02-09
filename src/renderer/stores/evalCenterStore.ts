// ============================================================================
// Eval Center Store - 评测中心统一状态
// ============================================================================
// 合并 telemetryStore 和 evaluation 数据，提供统一的数据加载入口
// ============================================================================

import { create } from 'zustand';
import type { ObjectiveMetrics } from '@shared/types/sessionAnalytics';

interface SessionInfo {
  title: string;
  modelProvider: string;
  modelName: string;
  startTime: number;
  endTime?: number;
  generationId: string;
  workingDirectory: string;
  status: string;
  turnCount: number;
  totalTokens: number;
  estimatedCost: number;
}

interface HistoricalEvaluation {
  id: string;
  timestamp: number;
  overallScore: number;
  grade: string;
}

interface EventSummary {
  eventStats: Record<string, number>;
  toolCalls: Array<{ name: string; success: boolean; duration?: number }>;
  thinkingContent: string[];
  errorEvents: Array<{ type: string; message: string }>;
  timeline: Array<{ time: number; type: string; summary: string }>;
}

interface EvalCenterStore {
  // State
  sessionInfo: SessionInfo | null;
  objective: ObjectiveMetrics | null;
  previousEvaluations: HistoricalEvaluation[];
  latestEvaluation: unknown | null;
  eventSummary: EventSummary | null;
  isLoading: boolean;
  error: string | null;

  // Session list state
  sessionList: Array<{
    id: string;
    title: string;
    modelProvider: string;
    modelName: string;
    startTime: number;
    endTime?: number;
    turnCount: number;
    totalTokens: number;
    estimatedCost: number;
    status: string;
  }>;
  sessionListLoading: boolean;
  filterStatus: 'all' | 'recording' | 'completed' | 'error';
  sortBy: 'time' | 'turns' | 'cost';

  // Actions
  loadSession: (sessionId: string) => Promise<void>;
  loadSessionList: () => Promise<void>;
  setFilterStatus: (status: 'all' | 'recording' | 'completed' | 'error') => void;
  setSortBy: (sort: 'time' | 'turns' | 'cost') => void;
  reset: () => void;
}

const initialState = {
  sessionInfo: null as SessionInfo | null,
  objective: null as ObjectiveMetrics | null,
  previousEvaluations: [] as HistoricalEvaluation[],
  latestEvaluation: null as unknown | null,
  eventSummary: null as EventSummary | null,
  isLoading: false,
  error: null as string | null,
  sessionList: [] as EvalCenterStore['sessionList'],
  sessionListLoading: false,
  filterStatus: 'all' as const,
  sortBy: 'time' as const,
};

export const useEvalCenterStore = create<EvalCenterStore>((set) => ({
  ...initialState,

  loadSession: async (sessionId: string) => {
    set({ isLoading: true, error: null });
    try {
      const analysis = await window.electronAPI?.invoke(
        'evaluation:get-session-analysis' as 'evaluation:get-session-analysis',
        sessionId
      );
      if (analysis) {
        set({
          sessionInfo: analysis.sessionInfo || null,
          objective: analysis.objective || null,
          previousEvaluations: analysis.previousEvaluations || [],
          latestEvaluation: analysis.latestEvaluation || null,
          eventSummary: analysis.eventSummary || null,
          isLoading: false,
        });
      } else {
        set({ isLoading: false });
      }
    } catch (error) {
      set({
        error: error instanceof Error ? error.message : '加载会话数据失败',
        isLoading: false,
      });
    }
  },

  loadSessionList: async () => {
    set({ sessionListLoading: true });
    try {
      const sessions = await window.electronAPI?.invoke(
        'telemetry:list-sessions' as 'telemetry:list-sessions',
        { limit: 200 }
      );
      if (sessions) {
        set({ sessionList: sessions, sessionListLoading: false });
      } else {
        set({ sessionListLoading: false });
      }
    } catch {
      set({ sessionListLoading: false });
    }
  },

  setFilterStatus: (status) => set({ filterStatus: status }),
  setSortBy: (sort) => set({ sortBy: sort }),

  reset: () => set(initialState),
}));
