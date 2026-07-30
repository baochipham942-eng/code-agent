import { create } from 'zustand';
import type { HookStartedEventData, HookTriggerEventData } from '@shared/contract';

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

/** 正在执行的 hook 批次（hook_started 到达、配对的 hook_trigger 未到达）。 */
export type HookRunningEvent = HookStartedEventData;

interface TurnExecutionStoreState {
  routingEventsBySession: Record<string, RoutingEvidenceEvent[]>;
  hookEventsBySession: Record<string, HookActivityEvent[]>;
  hookRunningBySession: Record<string, HookRunningEvent>;
  recordRoutingEvidence: (sessionId: string, event: RoutingEvidenceEvent) => void;
  recordHookActivity: (sessionId: string, event: HookActivityEvent) => void;
  recordHookStart: (sessionId: string, event: HookRunningEvent) => void;
  clearSession: (sessionId: string) => void;
  reset: () => void;
}

const MAX_ROUTING_EVENTS_PER_SESSION = 24;
const MAX_HOOK_EVENTS_PER_SESSION = 80;

export const useTurnExecutionStore = create<TurnExecutionStoreState>((set) => ({
  routingEventsBySession: {},
  hookEventsBySession: {},
  hookRunningBySession: {},

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
    set((state) => {
      // hook_trigger 是 hook_started 的配对完成信号：hook 批次在 agent loop 里严格
      // 串行（started→trigger→started→trigger），任何 trigger 到达都意味着当前没有
      // 在跑的批次——撤下 running 指示，对「started 漏收」的场景也能自愈。
      // 注意：没有 running 记录时保持切片引用不变——zustand v5 裸 useSyncExternalStore
      // 对切片引用敏感，每次 trigger 都新建对象会让订阅方白白重查快照（真机 #185 教训）。
      let nextRunning = state.hookRunningBySession;
      if (sessionId in nextRunning) {
        nextRunning = { ...nextRunning };
        delete nextRunning[sessionId];
      }
      return {
        hookRunningBySession: nextRunning,
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
      };
    }),

  recordHookStart: (sessionId, event) =>
    set((state) => {
      // 同一批次重复 started（SSE 重放/多订阅者）不换新引用，避免无意义快照变更
      const existing = state.hookRunningBySession[sessionId];
      if (
        existing?.event === event.event
        && existing.timestamp === event.timestamp
        && existing.turnId === event.turnId
      ) {
        return state;
      }
      return {
        hookRunningBySession: {
          ...state.hookRunningBySession,
          [sessionId]: event,
        },
      };
    }),

  clearSession: (sessionId) =>
    set((state) => {
      if (
        !(sessionId in state.routingEventsBySession)
        && !(sessionId in state.hookEventsBySession)
        && !(sessionId in state.hookRunningBySession)
      ) {
        return state;
      }

      const nextRouting = { ...state.routingEventsBySession };
      const nextHooks = { ...state.hookEventsBySession };
      const nextRunning = { ...state.hookRunningBySession };
      delete nextRouting[sessionId];
      delete nextHooks[sessionId];
      delete nextRunning[sessionId];
      return {
        routingEventsBySession: nextRouting,
        hookEventsBySession: nextHooks,
        hookRunningBySession: nextRunning,
      };
    }),

  reset: () => set({ routingEventsBySession: {}, hookEventsBySession: {}, hookRunningBySession: {} }),
}));
