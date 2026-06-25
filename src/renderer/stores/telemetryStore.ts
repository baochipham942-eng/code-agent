// ============================================================================
// Telemetry Store - 遥测数据 Zustand Store
// ============================================================================

import { create } from 'zustand';
import ipcService from '../services/ipcService';
import type { TelemetrySession, TelemetryTurn, TelemetryModelCall, TelemetryToolCall, TelemetryTimelineEvent, TelemetrySessionListItem, TelemetrySessionListOptions, TelemetryToolStat, TelemetryIntentStat, TelemetryPushEvent, TelemetryCostBucket, TelemetryCostByPeriodOptions } from '@shared/contract/telemetry';

interface TurnDetailData {
  turn: TelemetryTurn;
  modelCalls: TelemetryModelCall[];
  toolCalls: TelemetryToolCall[];
  events: TelemetryTimelineEvent[];
}

interface TelemetryStore {
  // State
  sessions: TelemetrySessionListItem[];
  currentSession: TelemetrySession | null;
  turns: TelemetryTurn[];
  events: TelemetryTimelineEvent[];
  selectedTurnDetail: TurnDetailData | null;
  sessionListOptions: TelemetrySessionListOptions;
  toolStats: TelemetryToolStat[];
  intentDistribution: TelemetryIntentStat[];
  costBuckets: TelemetryCostBucket[];
  isLive: boolean;
  isLoading: boolean;

  // Actions
  loadSessions: (options?: TelemetrySessionListOptions) => Promise<void>;
  loadCostByPeriod: (options: TelemetryCostByPeriodOptions) => Promise<void>;
  loadSession: (sessionId: string) => Promise<void>;
  loadTurns: (sessionId: string) => Promise<void>;
  loadEvents: (sessionId: string) => Promise<void>;
  loadTurnDetail: (turnId: string) => Promise<void>;
  loadToolStats: (sessionId: string) => Promise<void>;
  loadIntentDistribution: (sessionId: string) => Promise<void>;
  deleteSession: (sessionId: string) => Promise<void>;
  handlePushEvent: (event: TelemetryPushEvent) => void;
  setLive: (live: boolean) => void;
  reset: () => void;
}

const initialState = {
  sessions: [] as TelemetrySessionListItem[],
  currentSession: null as TelemetrySession | null,
  turns: [] as TelemetryTurn[],
  events: [] as TelemetryTimelineEvent[],
  selectedTurnDetail: null as TurnDetailData | null,
  sessionListOptions: {} as TelemetrySessionListOptions,
  toolStats: [] as TelemetryToolStat[],
  intentDistribution: [] as TelemetryIntentStat[],
  costBuckets: [] as TelemetryCostBucket[],
  isLive: true,
  isLoading: false
};

export const useTelemetryStore = create<TelemetryStore>((set, get) => ({
  ...initialState,

  loadSessions: async (options = get().sessionListOptions) => {
    set({ isLoading: true });
    try {
      const sessions = await ipcService.invoke('telemetry:list-sessions', {
        limit: 100,
        ...options
      });
      if (sessions) set({ sessions, sessionListOptions: options });
    } catch (error) {
      console.error('Failed to load telemetry sessions:', error);
    } finally {
      set({ isLoading: false });
    }
  },

  loadCostByPeriod: async (options: TelemetryCostByPeriodOptions) => {
    try {
      const buckets = await ipcService.invoke('telemetry:get-cost-by-period', options);
      if (buckets) set({ costBuckets: buckets });
    } catch (error) {
      console.error('Failed to load cost by period:', error);
    }
  },

  loadSession: async (sessionId: string) => {
    set({ isLoading: true });
    try {
      const session = await ipcService.invoke('telemetry:get-session', sessionId);
      if (session) set({ currentSession: session });
    } catch (error) {
      console.error('Failed to load telemetry session:', error);
    } finally {
      set({ isLoading: false });
    }
  },

  loadTurns: async (sessionId: string) => {
    try {
      const turns = await ipcService.invoke('telemetry:get-turns', sessionId);
      if (turns) set({ turns });
    } catch (error) {
      console.error('Failed to load telemetry turns:', error);
    }
  },

  loadEvents: async (sessionId: string) => {
    try {
      const events = await ipcService.invoke('telemetry:get-events' as const, sessionId);
      if (events) set({ events });
    } catch (error) {
      console.error('Failed to load telemetry events:', error);
    }
  },

  loadTurnDetail: async (turnId: string) => {
    try {
      const detail = await ipcService.invoke('telemetry:get-turn-detail', turnId);
      if (detail) set({ selectedTurnDetail: detail });
    } catch (error) {
      console.error('Failed to load turn detail:', error);
    }
  },

  loadToolStats: async (sessionId: string) => {
    try {
      const stats = await ipcService.invoke('telemetry:get-tool-stats', sessionId);
      if (stats) set({ toolStats: stats });
    } catch (error) {
      console.error('Failed to load tool stats:', error);
    }
  },

  loadIntentDistribution: async (sessionId: string) => {
    try {
      const dist = await ipcService.invoke('telemetry:get-intent-dist', sessionId);
      if (dist) set({ intentDistribution: dist });
    } catch (error) {
      console.error('Failed to load intent distribution:', error);
    }
  },

  deleteSession: async (sessionId: string) => {
    try {
      await ipcService.invoke('telemetry:delete-session', sessionId);
      set((state) => ({
        sessions: state.sessions.filter((s) => s.id !== sessionId),
        currentSession: state.currentSession?.id === sessionId ? null : state.currentSession
      }));
    } catch (error) {
      console.error('Failed to delete telemetry session:', error);
    }
  },

  handlePushEvent: (event: TelemetryPushEvent) => {
    if (!get().isLive) return;

    switch (event.type) {
      case 'session_start':
        // Refresh sessions list
        get().loadSessions();
        break;

      case 'session_end':
        // Refresh current session if matching
        if (get().currentSession?.id === event.sessionId) {
          get().loadSession(event.sessionId);
        }
        get().loadSessions();
        break;

      case 'turn_end':
        // Refresh turns if watching this session
        if (get().currentSession?.id === event.sessionId) {
          get().loadTurns(event.sessionId);
          get().loadEvents(event.sessionId);
          get().loadToolStats(event.sessionId);
          get().loadIntentDistribution(event.sessionId);
        }
        break;
    }
  },

  setLive: (live: boolean) => set({ isLive: live }),

  reset: () => set(initialState)
}));
