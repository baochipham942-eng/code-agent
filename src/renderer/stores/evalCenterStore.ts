// ============================================================================
// Eval Center Store - 评测中心统一状态
// ============================================================================
// 合并 telemetryStore 和 evaluation 数据，提供统一的数据加载入口
// ============================================================================

import { create } from 'zustand';
import type { ObjectiveMetrics } from '@shared/contract/sessionAnalytics';
import type {
  EnqueueReviewItemInput,
  ReviewQueueFailureCapabilityAssetStatus,
  ReviewQueueFailureAttributionInput,
  ReviewQueueItem,
  UnifiedTraceIdentity,
} from '@shared/contract/reviewQueue';
import { buildReviewQueueFailureCapabilityMetadata } from '@shared/contract/reviewQueue';
import { EVALUATION_CHANNELS } from '@shared/ipc/channels';
import ipcService from '../services/ipcService';

interface SessionInfo {
  title: string;
  modelProvider: string;
  modelName: string;
  startTime: number;
  endTime?: number;
  generationId?: string;
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

interface ReplaySummary {
  totalTurns: number;
  toolDistribution: Record<string, number>;
  thinkingRatio: number;
  selfRepairChains: number;
  totalDurationMs: number;
  deviations?: Array<{
    stepIndex: number;
    type: string;
    description: string;
    severity: string;
    suggestedFix?: string;
  }>;
  failureAttribution?: {
    rootCause?: {
      stepIndex: number;
      category: string;
      summary: string;
      evidence: number[];
      confidence: number;
    };
    causalChain: Array<{
      stepIndex: number;
      role: string;
      note: string;
    }>;
    relatedRegressionCases: string[];
    llmUsed: boolean;
    durationMs: number;
  };
}

interface ReplayBlock {
  type: 'user' | 'thinking' | 'text' | 'tool_call' | 'tool_result' | 'error';
  content: string;
  toolCall?: {
    id: string;
    name: string;
    args: Record<string, unknown>;
    result?: string;
    success: boolean;
    duration: number;
    category: string;
  };
  timestamp: number;
}

interface ReplayTurn {
  turnNumber: number;
  blocks: ReplayBlock[];
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
  startTime: number;
}

interface StructuredReplay {
  sessionId: string;
  traceIdentity: UnifiedTraceIdentity;
  turns: ReplayTurn[];
  summary: ReplaySummary;
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

  // Replay state
  replayData: StructuredReplay | null;
  replayLoading: boolean;

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
  reviewQueue: ReviewQueueItem[];
  reviewQueueLoading: boolean;

  // Actions
  loadSession: (sessionId: string) => Promise<void>;
  loadReplay: (sessionId: string) => Promise<void>;
  loadSessionList: () => Promise<void>;
  loadReviewQueue: () => Promise<void>;
  enqueueReviewItem: (payload: EnqueueReviewItemInput) => Promise<ReviewQueueItem | null>;
  updateFailureAssetStatus: (
    reviewItemId: string,
    status: ReviewQueueFailureCapabilityAssetStatus,
  ) => Promise<ReviewQueueItem | null>;
  enqueueFailureFollowup: (
    sessionId: string,
    sessionTitle?: string,
    failureAttribution?: ReviewQueueFailureAttributionInput,
  ) => Promise<ReviewQueueItem | null>;
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
  replayData: null as StructuredReplay | null,
  replayLoading: false,
  sessionList: [] as EvalCenterStore['sessionList'],
  sessionListLoading: false,
  filterStatus: 'all' as const,
  sortBy: 'time' as const,
  reviewQueue: [] as ReviewQueueItem[],
  reviewQueueLoading: false,
};

export const useEvalCenterStore = create<EvalCenterStore>((set) => ({
  ...initialState,

  loadSession: async (sessionId: string) => {
    set({ isLoading: true, error: null });
    try {
      const analysis = await ipcService.invoke(
        EVALUATION_CHANNELS.GET_SESSION_ANALYSIS,
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

  loadReplay: async (sessionId: string) => {
    set({ replayLoading: true });
    try {
      const data = await ipcService.invoke(
        'replay:get-structured-data' as const,
        sessionId
      );
      set({ replayData: (data as StructuredReplay) || null, replayLoading: false });
    } catch {
      set({ replayData: null, replayLoading: false });
    }
  },

  loadSessionList: async () => {
    set({ sessionListLoading: true });
    try {
      const sessions = await ipcService.invoke(
        'telemetry:list-sessions' as const,
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

  loadReviewQueue: async () => {
    set({ reviewQueueLoading: true });
    try {
      const items = await ipcService.invoke(EVALUATION_CHANNELS.REVIEW_QUEUE_LIST);
      set({ reviewQueue: items || [], reviewQueueLoading: false });
    } catch {
      set({ reviewQueueLoading: false });
    }
  },

  enqueueReviewItem: async (payload) => {
    try {
      const item = await ipcService.invoke(EVALUATION_CHANNELS.REVIEW_QUEUE_ENQUEUE, payload);
      if (item) {
        set((state) => {
          const next = state.reviewQueue.filter((existing) => existing.id !== item.id);
          next.unshift(item);
          return { reviewQueue: next };
        });
      }
      return item || null;
    } catch {
      return null;
    }
  },

  updateFailureAssetStatus: async (reviewItemId, status) => {
    try {
      const item = await ipcService.invoke(
        EVALUATION_CHANNELS.REVIEW_QUEUE_UPDATE_FAILURE_ASSET,
        { reviewItemId, status },
      );
      if (item) {
        set((state) => {
          const next = state.reviewQueue.filter((existing) => existing.id !== item.id);
          next.unshift(item);
          return { reviewQueue: next };
        });
      }
      return item || null;
    } catch {
      return null;
    }
  },

  enqueueFailureFollowup: async (sessionId, sessionTitle, failureAttribution) => {
    try {
      const failureCapability = buildReviewQueueFailureCapabilityMetadata(failureAttribution);
      const payload: EnqueueReviewItemInput = {
        sessionId,
        sessionTitle,
        reason: 'failure_followup',
        source: 'replay_failure',
      };
      if (failureCapability) {
        payload.failureCapability = failureCapability;
      }
      const item = await ipcService.invoke(EVALUATION_CHANNELS.REVIEW_QUEUE_ENQUEUE, payload);
      if (item) {
        set((state) => {
          const next = state.reviewQueue.filter((existing) => existing.id !== item.id);
          next.unshift(item);
          return { reviewQueue: next };
        });
      }
      return item || null;
    } catch {
      return null;
    }
  },

  setFilterStatus: (status) => set({ filterStatus: status }),
  setSortBy: (sort) => set({ sortBy: sort }),

  reset: () => set(initialState),
}));
