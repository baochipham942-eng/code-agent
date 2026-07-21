import { create } from 'zustand';
import type {
  SurfaceEvidenceCardV1,
  SurfaceSessionControlActionV1,
} from '@shared/contract/surfaceExecution';
import {
  buildSurfaceExecutionProjectionV1,
  surfaceExecutionScopeKeyV1,
} from '../utils/surfaceExecutionProjection';
import type {
  RendererSurfaceConversationProjectionV1,
  RendererSurfaceSessionProjectionV1,
  SurfaceExecutionCompatibilityEnvelopeV1,
  SurfaceExecutionScopeV1,
} from '../utils/surfaceExecutionProjection';

export interface SurfaceFrameViewStateV1 {
  scope: SurfaceExecutionScopeV1;
  status: 'idle' | 'pending' | 'ready' | 'stale' | 'failed';
  requestId?: string;
  frameRef?: string;
  observationStateId?: string;
  assetRef?: string;
  updatedAt?: number;
  error?: string;
}

export interface SurfaceEvidenceRequestStateV1 {
  evidenceId: SurfaceEvidenceCardV1['evidenceId'];
  status: 'pending' | 'ready' | 'failed';
  requestId?: string;
  startedAt?: number;
  settledAt?: number;
  error?: string;
}

export interface SurfaceEvidenceScopeStateV1 {
  scope: SurfaceExecutionScopeV1;
  requests: Record<string, SurfaceEvidenceRequestStateV1>;
}

export interface SurfaceControlRequestStateV1 {
  scope: SurfaceExecutionScopeV1;
  action: SurfaceSessionControlActionV1;
  status: 'pending' | 'succeeded' | 'failed';
  requestId?: string;
  startedAt: number;
  settledAt?: number;
  error?: string;
}

export interface SurfaceExecutionSessionSelectorV1 {
  conversationId: string;
  runId?: string;
  agentId?: string;
  surfaceSessionId?: string;
}

export interface SurfaceExecutionRunSessionSelectorV1 {
  conversationId: string | null;
  includeTerminal?: boolean;
}

interface SurfaceExecutionStoreState {
  nativeByConversation: Record<string, RendererSurfaceConversationProjectionV1>;
  compatibilityByConversation: Record<string, RendererSurfaceConversationProjectionV1>;
  sessionsByScope: Record<string, RendererSurfaceSessionProjectionV1>;
  frameByScope: Record<string, SurfaceFrameViewStateV1>;
  evidenceByScope: Record<string, SurfaceEvidenceScopeStateV1>;
  controlByScope: Record<string, SurfaceControlRequestStateV1>;
  setNativeSnapshot: (conversationId: string, snapshot: unknown) => boolean;
  clearNativeSnapshot: (conversationId: string) => void;
  replaceCompatibility: (
    conversationId: string,
    envelopes: readonly SurfaceExecutionCompatibilityEnvelopeV1[],
  ) => void;
  clearCompatibility: (conversationId: string) => void;
  setFrameState: (
    scope: SurfaceExecutionScopeV1,
    state: Omit<SurfaceFrameViewStateV1, 'scope'> | null,
  ) => void;
  setEvidenceRequestState: (
    scope: SurfaceExecutionScopeV1,
    evidenceId: string,
    state: Omit<SurfaceEvidenceRequestStateV1, 'evidenceId'> | null,
  ) => void;
  setControlRequestState: (
    scope: SurfaceExecutionScopeV1,
    state: Omit<SurfaceControlRequestStateV1, 'scope'> | null,
  ) => void;
  getSession: (scope: SurfaceExecutionScopeV1) => RendererSurfaceSessionProjectionV1 | undefined;
  getSessions: (selector: SurfaceExecutionSessionSelectorV1) => RendererSurfaceSessionProjectionV1[];
  clearConversation: (conversationId: string) => void;
  reset: () => void;
}

function withoutConversation<T extends { scope: SurfaceExecutionScopeV1 }>(
  values: Record<string, T>,
  conversationId: string,
): Record<string, T> {
  return Object.fromEntries(
    Object.entries(values).filter(([, value]) => value.scope.conversationId !== conversationId),
  );
}

function replaceConversationSessions(
  current: Record<string, RendererSurfaceSessionProjectionV1>,
  conversationId: string,
  sessions: readonly RendererSurfaceSessionProjectionV1[],
): Record<string, RendererSurfaceSessionProjectionV1> {
  const next = withoutConversation(current, conversationId);
  for (const session of sessions) {
    next[surfaceExecutionScopeKeyV1(session.scope)] = session;
  }
  return next;
}

function activeProjection(
  nativeByConversation: Record<string, RendererSurfaceConversationProjectionV1>,
  compatibilityByConversation: Record<string, RendererSurfaceConversationProjectionV1>,
  conversationId: string,
): RendererSurfaceConversationProjectionV1 | undefined {
  return nativeByConversation[conversationId] ?? compatibilityByConversation[conversationId];
}

function sessionsMatching(
  values: Record<string, RendererSurfaceSessionProjectionV1>,
  selector: SurfaceExecutionSessionSelectorV1,
): RendererSurfaceSessionProjectionV1[] {
  return Object.values(values)
    .filter(({ scope }) => (
      scope.conversationId === selector.conversationId
      && (selector.runId === undefined || scope.runId === selector.runId)
      && (selector.agentId === undefined || scope.agentId === selector.agentId)
      && (selector.surfaceSessionId === undefined || scope.surfaceSessionId === selector.surfaceSessionId)
    ))
    .sort((left, right) => (
      left.session.startedAt - right.session.startedAt
      || left.scope.runId.localeCompare(right.scope.runId)
      || left.scope.agentId.localeCompare(right.scope.agentId)
      || left.scope.surfaceSessionId.localeCompare(right.scope.surfaceSessionId)
    ));
}

const TERMINAL_SURFACE_SESSION_STATES = new Set(['completed', 'failed']);

function sessionOwnsScope(session: RendererSurfaceSessionProjectionV1): boolean {
  return session.session.conversationId === session.scope.conversationId
    && session.session.runId === session.scope.runId
    && session.session.agentId === session.scope.agentId
    && session.session.sessionId === session.scope.surfaceSessionId;
}

/**
 * Selects the authoritative Surface Session displayed for one conversation.
 * All status surfaces use this ordering and the full owner scope, so a newer
 * session belonging to another conversation, run, or agent cannot win.
 */
export function selectSurfaceExecutionRunSessionV1(
  sessionsByScope: Record<string, RendererSurfaceSessionProjectionV1>,
  selector: SurfaceExecutionRunSessionSelectorV1,
): RendererSurfaceSessionProjectionV1 | null {
  const conversationId = selector.conversationId?.trim();
  if (!conversationId) return null;
  const includeTerminal = selector.includeTerminal !== false;
  const sessions = Object.values(sessionsByScope)
    .filter((candidate) => (
      candidate.scope.conversationId === conversationId
      && sessionOwnsScope(candidate)
    ))
    .sort((left, right) => (
      right.updatedAt - left.updatedAt
      || right.session.heartbeatAt - left.session.heartbeatAt
      || right.session.startedAt - left.session.startedAt
      || surfaceExecutionScopeKeyV1(right.scope).localeCompare(surfaceExecutionScopeKeyV1(left.scope))
    ));
  const active = sessions.find((candidate) => (
    !TERMINAL_SURFACE_SESSION_STATES.has(candidate.session.state)
  ));
  return active ?? (includeTerminal ? sessions[0] ?? null : null);
}

export const useSurfaceExecutionStore = create<SurfaceExecutionStoreState>()((set, get) => ({
  nativeByConversation: {},
  compatibilityByConversation: {},
  sessionsByScope: {},
  frameByScope: {},
  evidenceByScope: {},
  controlByScope: {},

  setNativeSnapshot: (conversationId, snapshot) => {
    const projection = buildSurfaceExecutionProjectionV1({ conversationId, nativeSnapshot: snapshot });
    if (projection.mode !== 'native') return false;
    set((state) => {
      const current = state.nativeByConversation[conversationId];
      if (current && projection.updatedAt < current.updatedAt) return state;
      const nativeByConversation = {
        ...state.nativeByConversation,
        [conversationId]: projection,
      };
      return {
        nativeByConversation,
        sessionsByScope: replaceConversationSessions(
          state.sessionsByScope,
          conversationId,
          projection.sessions,
        ),
      };
    });
    return true;
  },

  clearNativeSnapshot: (conversationId) => set((state) => {
    if (!(conversationId in state.nativeByConversation)) return state;
    const nativeByConversation = { ...state.nativeByConversation };
    delete nativeByConversation[conversationId];
    const fallback = activeProjection(
      nativeByConversation,
      state.compatibilityByConversation,
      conversationId,
    );
    return {
      nativeByConversation,
      sessionsByScope: replaceConversationSessions(
        state.sessionsByScope,
        conversationId,
        fallback?.sessions ?? [],
      ),
    };
  }),

  replaceCompatibility: (conversationId, envelopes) => set((state) => {
    const projection = buildSurfaceExecutionProjectionV1({ conversationId, compatibility: envelopes });
    const compatibilityByConversation = {
      ...state.compatibilityByConversation,
      [conversationId]: projection,
    };
    const active = activeProjection(state.nativeByConversation, compatibilityByConversation, conversationId);
    return {
      compatibilityByConversation,
      sessionsByScope: replaceConversationSessions(
        state.sessionsByScope,
        conversationId,
        active?.sessions ?? [],
      ),
    };
  }),

  clearCompatibility: (conversationId) => set((state) => {
    if (!(conversationId in state.compatibilityByConversation)) return state;
    const compatibilityByConversation = { ...state.compatibilityByConversation };
    delete compatibilityByConversation[conversationId];
    const active = activeProjection(state.nativeByConversation, compatibilityByConversation, conversationId);
    return {
      compatibilityByConversation,
      sessionsByScope: replaceConversationSessions(
        state.sessionsByScope,
        conversationId,
        active?.sessions ?? [],
      ),
    };
  }),

  setFrameState: (scope, frameState) => set((state) => {
    const key = surfaceExecutionScopeKeyV1(scope);
    const frameByScope = { ...state.frameByScope };
    if (frameState) frameByScope[key] = { scope, ...frameState };
    else delete frameByScope[key];
    return { frameByScope };
  }),

  setEvidenceRequestState: (scope, evidenceId, requestState) => set((state) => {
    const key = surfaceExecutionScopeKeyV1(scope);
    const current = state.evidenceByScope[key];
    const requests = { ...(current?.requests ?? {}) };
    if (requestState) requests[evidenceId] = { evidenceId, ...requestState };
    else delete requests[evidenceId];
    const evidenceByScope = { ...state.evidenceByScope };
    if (Object.keys(requests).length > 0) evidenceByScope[key] = { scope, requests };
    else delete evidenceByScope[key];
    return { evidenceByScope };
  }),

  setControlRequestState: (scope, requestState) => set((state) => {
    const key = surfaceExecutionScopeKeyV1(scope);
    const controlByScope = { ...state.controlByScope };
    if (requestState) controlByScope[key] = { scope, ...requestState };
    else delete controlByScope[key];
    return { controlByScope };
  }),

  getSession: (scope) => get().sessionsByScope[surfaceExecutionScopeKeyV1(scope)],

  getSessions: (selector) => sessionsMatching(get().sessionsByScope, selector),

  clearConversation: (conversationId) => set((state) => {
    const nativeByConversation = { ...state.nativeByConversation };
    const compatibilityByConversation = { ...state.compatibilityByConversation };
    delete nativeByConversation[conversationId];
    delete compatibilityByConversation[conversationId];
    return {
      nativeByConversation,
      compatibilityByConversation,
      sessionsByScope: withoutConversation(state.sessionsByScope, conversationId),
      frameByScope: withoutConversation(state.frameByScope, conversationId),
      evidenceByScope: withoutConversation(state.evidenceByScope, conversationId),
      controlByScope: withoutConversation(state.controlByScope, conversationId),
    };
  }),

  reset: () => set({
    nativeByConversation: {},
    compatibilityByConversation: {},
    sessionsByScope: {},
    frameByScope: {},
    evidenceByScope: {},
    controlByScope: {},
  }),
}));
