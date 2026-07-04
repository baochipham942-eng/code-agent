import { create } from 'zustand';
import type { HookTriggerEventData } from '@shared/contract';

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
  /** explicit = 用户显式 /agent 选择产生的路由真相事件 */
  mode: 'auto' | 'explicit';
  timestamp: number;
  agentId: string;
  agentName: string;
  reason: string;
  score: number;
  fallbackToDefault?: boolean;
  /** 用户显式请求的 agent id；与 agentId 不一致 = 显式选择已降级 */
  requestedAgentId?: string;
}

export type RoutingEvidenceEvent =
  | DirectRoutingEvidenceEvent
  | AutoRoutingEvidenceEvent;

export type HookActivityEvent = HookTriggerEventData;

interface TurnExecutionStoreState {
  routingEventsBySession: Record<string, RoutingEvidenceEvent[]>;
  hookEventsBySession: Record<string, HookActivityEvent[]>;
  recordRoutingEvidence: (sessionId: string, event: RoutingEvidenceEvent) => void;
  recordHookActivity: (sessionId: string, event: HookActivityEvent) => void;
  clearSession: (sessionId: string) => void;
  reset: () => void;
}

const MAX_ROUTING_EVENTS_PER_SESSION = 24;
const MAX_HOOK_EVENTS_PER_SESSION = 80;

export const useTurnExecutionStore = create<TurnExecutionStoreState>((set) => ({
  routingEventsBySession: {},
  hookEventsBySession: {},

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

  recordHookActivity: (sessionId, event) =>
    set((state) => ({
      hookEventsBySession: {
        ...state.hookEventsBySession,
        [sessionId]: [
          ...(state.hookEventsBySession[sessionId] || []).filter((existing) => !(
            existing.timestamp === event.timestamp
            && existing.event === event.event
            && existing.toolName === event.toolName
            && existing.action === event.action
          )),
          event,
        ]
          .sort((left, right) => left.timestamp - right.timestamp)
          .slice(-MAX_HOOK_EVENTS_PER_SESSION),
      },
    })),

  clearSession: (sessionId) =>
    set((state) => {
      if (!(sessionId in state.routingEventsBySession) && !(sessionId in state.hookEventsBySession)) {
        return state;
      }

      const nextRouting = { ...state.routingEventsBySession };
      const nextHooks = { ...state.hookEventsBySession };
      delete nextRouting[sessionId];
      delete nextHooks[sessionId];
      return {
        routingEventsBySession: nextRouting,
        hookEventsBySession: nextHooks,
      };
    }),

  reset: () => set({ routingEventsBySession: {}, hookEventsBySession: {} }),
}));
