import { useCallback, useEffect, useRef } from 'react';
import type { AgentEventEnvelope, Message, ToolResult } from '@shared/contract';
import { isSurfaceExecutionEventV1 } from '@shared/contract/surfaceExecution';
import { getSurfaceExecutionSnapshot } from '../../../services/surfaceExecutionClient';
import { useSessionStore } from '../../../stores/sessionStore';
import { useSurfaceExecutionStore } from '../../../stores/surfaceExecutionStore';
import type { SurfaceExecutionCompatibilityEnvelopeV1 } from '../../../utils/surfaceExecutionProjection';
import { createLogger } from '../../../utils/logger';
import ipcService from '../../../services/ipcService';

const logger = createLogger('SurfaceExecutionEffects');
const LIVE_REFRESH_DELAY_MS = 50;

type SurfaceAgentEvent = AgentEventEnvelope | { type: string; data?: unknown; sessionId?: string };

export interface SurfaceExecutionEffectsE2EDiagnostics {
  renderCount: number;
  lastRenderConversationId: string | null;
  compatibilityEffectCount: number;
  lastCompatibilityConversationId: string | null;
  initialEffectCount: number;
  lastInitialEffectConversationId: string | null;
  eventSubscriptionEffectCount: number;
  eventReceivedCount: number;
  lastEventConversationId: string | null;
  initialRefreshCount: number;
  eventRefreshCount: number;
  refreshSettledCount: number;
  lastRefreshReason: 'initial' | 'event' | null;
  lastRefreshConversationId: string | null;
  lastRefreshResult: boolean | null;
  lastError: string | null;
}

type SurfaceDiagnosticsWindow = Window & {
  __surfaceExecutionEffectsE2E?: SurfaceExecutionEffectsE2EDiagnostics;
};

function isSurfaceExecutionE2E(): boolean {
  return typeof window !== 'undefined'
    && new URLSearchParams(window.location.search).get('e2e') === '1';
}

function updateSurfaceExecutionE2EDiagnostics(
  mutate: (diagnostics: SurfaceExecutionEffectsE2EDiagnostics) => void,
): void {
  if (!isSurfaceExecutionE2E()) return;
  const target = window as SurfaceDiagnosticsWindow;
  const diagnostics = target.__surfaceExecutionEffectsE2E ?? {
    renderCount: 0,
    lastRenderConversationId: null,
    compatibilityEffectCount: 0,
    lastCompatibilityConversationId: null,
    initialEffectCount: 0,
    lastInitialEffectConversationId: null,
    eventSubscriptionEffectCount: 0,
    eventReceivedCount: 0,
    lastEventConversationId: null,
    initialRefreshCount: 0,
    eventRefreshCount: 0,
    refreshSettledCount: 0,
    lastRefreshReason: null,
    lastRefreshConversationId: null,
    lastRefreshResult: null,
    lastError: null,
  };
  mutate(diagnostics);
  target.__surfaceExecutionEffectsE2E = diagnostics;
}

function recordRefreshStart(
  reason: 'initial' | 'event',
  conversationId: string,
): void {
  updateSurfaceExecutionE2EDiagnostics((diagnostics) => {
    if (reason === 'initial') diagnostics.initialRefreshCount += 1;
    else diagnostics.eventRefreshCount += 1;
    diagnostics.lastRefreshReason = reason;
    diagnostics.lastRefreshConversationId = conversationId;
    diagnostics.lastRefreshResult = null;
    diagnostics.lastError = null;
  });
}

function recordRefreshSettled(
  reason: 'initial' | 'event',
  conversationId: string,
  result: boolean,
): void {
  updateSurfaceExecutionE2EDiagnostics((diagnostics) => {
    diagnostics.refreshSettledCount += 1;
    diagnostics.lastRefreshReason = reason;
    diagnostics.lastRefreshConversationId = conversationId;
    diagnostics.lastRefreshResult = result;
  });
}

export function getSurfaceExecutionConversationId(event: SurfaceAgentEvent): string | null {
  if (event.type !== 'surface_execution' || !isSurfaceExecutionEventV1(event.data)) return null;
  const outerConversationId = event.sessionId?.trim();
  if (!outerConversationId) return null;
  if (event.data.conversationId && event.data.conversationId !== outerConversationId) return null;
  return outerConversationId;
}

function collectMessageToolResults(message: Message): ToolResult[] {
  const byToolCallId = new Map<string, ToolResult>();
  for (const call of message.toolCalls ?? []) {
    if (call.result) byToolCallId.set(call.result.toolCallId, call.result);
  }
  for (const result of message.toolResults ?? []) {
    byToolCallId.set(result.toolCallId, result);
  }
  return Array.from(byToolCallId.values());
}

export function buildSurfaceExecutionCompatibilityEnvelopes(
  conversationId: string,
  messages: readonly Message[],
): SurfaceExecutionCompatibilityEnvelopeV1[] {
  return messages.flatMap((message) => {
    if (message.visibility === 'rewound') return [];
    const toolResults = collectMessageToolResults(message);
    if (toolResults.length === 0) return [];
    const owner = message.metadata?.agentTeam;
    return [{
      conversationId,
      ...(owner?.runId ? { runId: owner.runId } : {}),
      ...(owner?.agentId ? { agentId: owner.agentId } : {}),
      toolResults,
    }];
  });
}

export interface SurfaceSnapshotRefreshCoordinator {
  refresh: (conversationId: string) => Promise<boolean>;
}

export function createSurfaceSnapshotRefreshCoordinator(deps: {
  fetchSnapshot: typeof getSurfaceExecutionSnapshot;
  acceptSnapshot: (conversationId: string, snapshot: unknown) => boolean;
  onError?: (conversationId: string, error: unknown) => void;
}): SurfaceSnapshotRefreshCoordinator {
  const generationByConversation = new Map<string, number>();
  return {
    refresh: async (conversationId) => {
      const generation = (generationByConversation.get(conversationId) ?? 0) + 1;
      generationByConversation.set(conversationId, generation);
      try {
        const snapshot = await deps.fetchSnapshot(conversationId);
        if (generationByConversation.get(conversationId) !== generation) return false;
        return deps.acceptSnapshot(conversationId, snapshot);
      } catch (error) {
        if (generationByConversation.get(conversationId) === generation) {
          deps.onError?.(conversationId, error);
        }
        return false;
      }
    },
  };
}

export function useSurfaceExecutionEffects(currentSessionId: string | null): void {
  updateSurfaceExecutionE2EDiagnostics((diagnostics) => {
    diagnostics.renderCount += 1;
    diagnostics.lastRenderConversationId = currentSessionId;
  });
  const messages = useSessionStore((state) => state.messages);
  const coordinatorRef = useRef<SurfaceSnapshotRefreshCoordinator | null>(null);
  const timersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  if (!coordinatorRef.current) {
    coordinatorRef.current = createSurfaceSnapshotRefreshCoordinator({
      fetchSnapshot: getSurfaceExecutionSnapshot,
      acceptSnapshot: (conversationId, snapshot) => (
        useSurfaceExecutionStore.getState().setNativeSnapshot(conversationId, snapshot)
      ),
      onError: (conversationId, error) => {
        updateSurfaceExecutionE2EDiagnostics((diagnostics) => {
          diagnostics.lastRefreshConversationId = conversationId;
          diagnostics.lastRefreshResult = false;
          diagnostics.lastError = error instanceof Error ? error.message : String(error);
        });
        logger.warn('Failed to refresh Surface Execution snapshot', { conversationId, error });
      },
    });
  }

  const refresh = useCallback((conversationId: string) => {
    const coordinator = coordinatorRef.current;
    return coordinator ? coordinator.refresh(conversationId) : Promise.resolve(false);
  }, []);

  useEffect(() => {
    updateSurfaceExecutionE2EDiagnostics((diagnostics) => {
      diagnostics.compatibilityEffectCount += 1;
      diagnostics.lastCompatibilityConversationId = currentSessionId;
    });
    if (!currentSessionId) return;
    useSurfaceExecutionStore.getState().replaceCompatibility(
      currentSessionId,
      buildSurfaceExecutionCompatibilityEnvelopes(currentSessionId, messages),
    );
  }, [currentSessionId, messages]);

  useEffect(() => {
    updateSurfaceExecutionE2EDiagnostics((diagnostics) => {
      diagnostics.initialEffectCount += 1;
      diagnostics.lastInitialEffectConversationId = currentSessionId;
    });
    if (!currentSessionId) return;
    recordRefreshStart('initial', currentSessionId);
    void refresh(currentSessionId).then((result) => {
      recordRefreshSettled('initial', currentSessionId, result);
    });
  }, [currentSessionId, refresh]);

  useEffect(() => {
    updateSurfaceExecutionE2EDiagnostics((diagnostics) => {
      diagnostics.eventSubscriptionEffectCount += 1;
    });
    const unsubscribe = ipcService.on('agent:event', (event) => {
      const conversationId = getSurfaceExecutionConversationId(event);
      if (!conversationId) return;
      updateSurfaceExecutionE2EDiagnostics((diagnostics) => {
        diagnostics.eventReceivedCount += 1;
        diagnostics.lastEventConversationId = conversationId;
      });
      const existing = timersRef.current.get(conversationId);
      if (existing) clearTimeout(existing);
      const timer = setTimeout(() => {
        timersRef.current.delete(conversationId);
        recordRefreshStart('event', conversationId);
        void refresh(conversationId).then((result) => {
          recordRefreshSettled('event', conversationId, result);
        });
      }, LIVE_REFRESH_DELAY_MS);
      timersRef.current.set(conversationId, timer);
    });
    return () => {
      unsubscribe?.();
      for (const timer of timersRef.current.values()) clearTimeout(timer);
      timersRef.current.clear();
    };
  }, [refresh]);
}
