// ============================================================================
// Telemetry Store - 遥测数据 Zustand Store
// ============================================================================

import { create } from 'zustand';
import type {
  TelemetrySession,
  TelemetryTurn,
  TelemetryModelCall,
  TelemetryToolCall,
  TelemetryTimelineEvent,
  TelemetrySessionListItem,
  TelemetryToolStat,
  TelemetryIntentStat,
  TelemetryPushEvent,
} from '@shared/types/telemetry';

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
  selectedTurnDetail: TurnDetailData | null;
  toolStats: TelemetryToolStat[];
  intentDistribution: TelemetryIntentStat[];
  isLive: boolean;
  isLoading: boolean;

  // Actions
  loadSessions: () => Promise<void>;
  loadSession: (sessionId: string) => Promise<void>;
  loadTurns: (sessionId: string) => Promise<void>;
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
  selectedTurnDetail: null as TurnDetailData | null,
  toolStats: [] as TelemetryToolStat[],
  intentDistribution: [] as TelemetryIntentStat[],
  isLive: true,
  isLoading: false,
};

export const useTelemetryStore = create<TelemetryStore>((set, get) => ({
  ...initialState,

  loadSessions: async () => {
    set({ isLoading: true });
    try {
      const sessions = await window.electronAPI?.invoke('telemetry:list-sessions', { limit: 100 });
      if (sessions) set({ sessions });
    } catch (error) {
      console.error('Failed to load telemetry sessions:', error);
    } finally {
      set({ isLoading: false });
    }
  },

  loadSession: async (sessionId: string) => {
    set({ isLoading: true });
    try {
      const session = await window.electronAPI?.invoke('telemetry:get-session', sessionId);
      if (session) set({ currentSession: session });
    } catch (error) {
      console.error('Failed to load telemetry session:', error);
    } finally {
      set({ isLoading: false });
    }
  },

  loadTurns: async (sessionId: string) => {
    try {
      const turns = await window.electronAPI?.invoke('telemetry:get-turns', sessionId);
      if (turns) set({ turns });
    } catch (error) {
      console.error('Failed to load telemetry turns:', error);
    }
  },

  loadTurnDetail: async (turnId: string) => {
    try {
      const detail = await window.electronAPI?.invoke('telemetry:get-turn-detail', turnId);
      if (detail) set({ selectedTurnDetail: detail });
    } catch (error) {
      console.error('Failed to load turn detail:', error);
    }
  },

  loadToolStats: async (sessionId: string) => {
    try {
      const stats = await window.electronAPI?.invoke('telemetry:get-tool-stats', sessionId);
      if (stats) set({ toolStats: stats });
    } catch (error) {
      console.error('Failed to load tool stats:', error);
    }
  },

  loadIntentDistribution: async (sessionId: string) => {
    try {
      const dist = await window.electronAPI?.invoke('telemetry:get-intent-dist', sessionId);
      if (dist) set({ intentDistribution: dist });
    } catch (error) {
      console.error('Failed to load intent distribution:', error);
    }
  },

  deleteSession: async (sessionId: string) => {
    try {
      await window.electronAPI?.invoke('telemetry:delete-session', sessionId);
      set((state) => ({
        sessions: state.sessions.filter(s => s.id !== sessionId),
        currentSession: state.currentSession?.id === sessionId ? null : state.currentSession,
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
          get().loadToolStats(event.sessionId);
          get().loadIntentDistribution(event.sessionId);
        }
        break;
    }
  },

  setLive: (live: boolean) => set({ isLive: live }),

  reset: () => set(initialState),
}));
