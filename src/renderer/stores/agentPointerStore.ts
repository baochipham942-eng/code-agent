import { create } from 'zustand';
import type { AgentPointerEvent, AgentPointerSurface } from '@shared/contract';

export interface AgentPointerTimelineEntry {
  event: AgentPointerEvent;
  receivedAtMs: number;
  visibleUntilMs: number;
}

interface AgentPointerState {
  lastBySurface: Record<AgentPointerSurface, AgentPointerTimelineEntry | null>;
  timeline: AgentPointerTimelineEntry[];
}

interface AgentPointerActions {
  recordEvent: (event: AgentPointerEvent) => void;
  pruneExpired: (nowMs?: number) => void;
  clearSurface: (surface: AgentPointerSurface) => void;
  clearAll: () => void;
}

type AgentPointerStore = AgentPointerState & AgentPointerActions;

const EMPTY_LAST_BY_SURFACE: Record<AgentPointerSurface, AgentPointerTimelineEntry | null> = {
  browser: null,
  computer: null,
};

const DEFAULT_VISIBLE_TTL_MS = 2200;
const TIMELINE_LIMIT = 120;

function visibleUntilForEvent(event: AgentPointerEvent, receivedAtMs: number): number {
  if (typeof event.expiresAtMs === 'number' && Number.isFinite(event.expiresAtMs)) {
    return event.expiresAtMs;
  }
  if (event.phase === 'failed' || event.phase === 'blocked') {
    return receivedAtMs + 3600;
  }
  if (event.phase === 'read') {
    return receivedAtMs + 1600;
  }
  return receivedAtMs + DEFAULT_VISIBLE_TTL_MS;
}

export function isAgentPointerEvent(value: unknown): value is AgentPointerEvent {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  const point = record.point as Record<string, unknown> | null | undefined;
  return typeof record.id === 'string'
    && (record.surface === 'browser' || record.surface === 'computer')
    && typeof record.tone === 'string'
    && typeof record.phase === 'string'
    && typeof record.coordSpace === 'string'
    && (
      point == null
      || (
        typeof point === 'object'
        && typeof point.x === 'number'
        && typeof point.y === 'number'
        && (point.unit === 'px' || point.unit === 'percent')
      )
    );
}

export const useAgentPointerStore = create<AgentPointerStore>()((set) => ({
  lastBySurface: EMPTY_LAST_BY_SURFACE,
  timeline: [],

  recordEvent: (event) =>
    set((state) => {
      const receivedAtMs = Date.now();
      const normalizedEvent: AgentPointerEvent = {
        ...event,
        occurredAtMs: event.occurredAtMs ?? receivedAtMs,
        expiresAtMs: event.expiresAtMs ?? visibleUntilForEvent(event, receivedAtMs),
      };
      const entry: AgentPointerTimelineEntry = {
        event: normalizedEvent,
        receivedAtMs,
        visibleUntilMs: normalizedEvent.expiresAtMs ?? visibleUntilForEvent(normalizedEvent, receivedAtMs),
      };
      return {
        lastBySurface: {
          ...state.lastBySurface,
          [normalizedEvent.surface]: entry,
        },
        timeline: [...state.timeline, entry].slice(-TIMELINE_LIMIT),
      };
    }),

  pruneExpired: (nowMs = Date.now()) =>
    set((state) => {
      const nextLastBySurface = { ...state.lastBySurface };
      let changed = false;
      for (const surface of Object.keys(nextLastBySurface) as AgentPointerSurface[]) {
        const entry = nextLastBySurface[surface];
        if (entry && entry.visibleUntilMs <= nowMs) {
          nextLastBySurface[surface] = null;
          changed = true;
        }
      }
      return changed ? { lastBySurface: nextLastBySurface } : state;
    }),

  clearSurface: (surface) =>
    set((state) => ({
      lastBySurface: {
        ...state.lastBySurface,
        [surface]: null,
      },
    })),

  clearAll: () =>
    set({
      lastBySurface: { ...EMPTY_LAST_BY_SURFACE },
      timeline: [],
    }),
}));

export function selectAgentPointerTimelineForSurface(
  state: AgentPointerState,
  surface: AgentPointerSurface,
  limit = 6,
): AgentPointerTimelineEntry[] {
  return state.timeline
    .filter((entry) => entry.event.surface === surface)
    .slice(-limit)
    .reverse();
}
