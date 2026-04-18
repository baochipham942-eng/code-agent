import { create } from 'zustand';

export interface DirectRoutingEvidenceEvent {
  kind: 'direct';
  mode: 'direct';
  timestamp: number;
  turnMessageId: string;
  targetAgentIds: string[];
  targetAgentNames: string[];
  deliveredTargetIds: string[];
  missingTargetIds: string[];
}

export interface AutoRoutingEvidenceEvent {
  kind: 'auto';
  mode: 'auto';
  timestamp: number;
  agentId: string;
  agentName: string;
  reason: string;
  score: number;
  fallbackToDefault?: boolean;
}

export type RoutingEvidenceEvent =
  | DirectRoutingEvidenceEvent
  | AutoRoutingEvidenceEvent;

interface TurnExecutionStoreState {
  routingEventsBySession: Record<string, RoutingEvidenceEvent[]>;
  recordRoutingEvidence: (sessionId: string, event: RoutingEvidenceEvent) => void;
  clearSession: (sessionId: string) => void;
  reset: () => void;
}

const MAX_ROUTING_EVENTS_PER_SESSION = 24;

export const useTurnExecutionStore = create<TurnExecutionStoreState>((set) => ({
  routingEventsBySession: {},

  recordRoutingEvidence: (sessionId, event) =>
    set((state) => ({
      routingEventsBySession: {
        ...state.routingEventsBySession,
        [sessionId]: [
          ...(state.routingEventsBySession[sessionId] || []).filter((existing) => {
            if (event.kind === 'direct' && existing.kind === 'direct') {
              return existing.turnMessageId !== event.turnMessageId;
            }

            if (event.kind === 'auto' && existing.kind === 'auto') {
              return !(
                existing.timestamp === event.timestamp
                && existing.agentId === event.agentId
                && existing.reason === event.reason
              );
            }

            return true;
          }),
          event,
        ]
          .sort((left, right) => left.timestamp - right.timestamp)
          .slice(-MAX_ROUTING_EVENTS_PER_SESSION),
      },
    })),

  clearSession: (sessionId) =>
    set((state) => {
      if (!(sessionId in state.routingEventsBySession)) {
        return state;
      }

      const next = { ...state.routingEventsBySession };
      delete next[sessionId];
      return { routingEventsBySession: next };
    }),

  reset: () => set({ routingEventsBySession: {} }),
}));
