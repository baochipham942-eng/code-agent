// ============================================================================
// Swarm Store - Agent Swarm 实时状态管理
// ============================================================================

import { create } from 'zustand';
import type { SwarmAgentState, SwarmExecutionState, SwarmEvent } from '@shared/types/swarm';

interface SwarmStore extends SwarmExecutionState {
  // Actions
  handleEvent: (event: SwarmEvent) => void;
  reset: () => void;
}

const initialState: SwarmExecutionState = {
  isRunning: false,
  agents: [],
  statistics: {
    total: 0,
    completed: 0,
    failed: 0,
    running: 0,
    pending: 0,
    parallelPeak: 0,
    totalTokens: 0,
    totalToolCalls: 0,
  },
};

export const useSwarmStore = create<SwarmStore>((set, get) => ({
  ...initialState,

  handleEvent: (event: SwarmEvent) => {
    const { type, data } = event;

    switch (type) {
      case 'swarm:started':
        set({
          isRunning: true,
          startTime: event.timestamp,
          agents: [],
          statistics: data.statistics || initialState.statistics,
        });
        break;

      case 'swarm:agent:added':
        if (data.agentState) {
          set((state) => ({
            agents: [...state.agents, data.agentState!],
            statistics: {
              ...state.statistics,
              total: state.statistics.total + 1,
              pending: state.statistics.pending + 1,
            },
          }));
        }
        break;

      case 'swarm:agent:updated':
        if (data.agentId && data.agentState) {
          set((state) => {
            const agents = state.agents.map((a) =>
              a.id === data.agentId ? { ...a, ...data.agentState } : a
            );

            // 更新统计
            const running = agents.filter((a) => a.status === 'running').length;
            const pending = agents.filter((a) => a.status === 'pending' || a.status === 'ready').length;
            const parallelPeak = Math.max(state.statistics.parallelPeak, running);

            // 计算总 token 和工具调用
            const totalTokens = agents.reduce((sum, a) => {
              const usage = a.tokenUsage || { input: 0, output: 0 };
              return sum + usage.input + usage.output;
            }, 0);
            const totalToolCalls = agents.reduce((sum, a) => sum + (a.toolCalls || 0), 0);

            return {
              agents,
              statistics: {
                ...state.statistics,
                running,
                pending,
                parallelPeak,
                totalTokens,
                totalToolCalls,
              },
            };
          });
        }
        break;

      case 'swarm:agent:completed':
        if (data.agentId) {
          set((state) => {
            const agents = state.agents.map((a) =>
              a.id === data.agentId
                ? { ...a, ...data.agentState, status: 'completed' as const }
                : a
            );
            return {
              agents,
              statistics: {
                ...state.statistics,
                completed: state.statistics.completed + 1,
                running: Math.max(0, state.statistics.running - 1),
              },
            };
          });
        }
        break;

      case 'swarm:agent:failed':
        if (data.agentId) {
          set((state) => {
            const agents = state.agents.map((a) =>
              a.id === data.agentId
                ? { ...a, ...data.agentState, status: 'failed' as const }
                : a
            );
            return {
              agents,
              statistics: {
                ...state.statistics,
                failed: state.statistics.failed + 1,
                running: Math.max(0, state.statistics.running - 1),
              },
            };
          });
        }
        break;

      case 'swarm:completed':
      case 'swarm:cancelled':
        set((state) => ({
          isRunning: false,
          statistics: data.statistics || state.statistics,
        }));
        break;
    }
  },

  reset: () => set(initialState),
}));
