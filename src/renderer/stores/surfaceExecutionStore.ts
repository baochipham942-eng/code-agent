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
import { createLogger } from '../utils/logger';

const logger = createLogger('SurfaceExecutionStore');

/**
 * `setNativeSnapshot` 的落地结果，三种结局必须可区分：
 * - `'applied'`：快照已写入 store；
 * - `'stale'`：快照比现存投影旧，被「旧不覆盖新」规则丢弃（正常并发现象，不是错误）；
 * - `'invalid'`：快照未通过 `buildSurfaceExecutionProjectionV1` 校验，未写入。
 */
export type SurfaceSnapshotApplyResultV1 = 'applied' | 'stale' | 'invalid';

export interface SurfaceFrameViewStateV1 {
  scope: SurfaceExecutionScopeV1;
  status: 'idle' | 'pending' | 'ready' | 'stale' | 'failed';
  requestId?: string;
  frameRef?: string;
  observationStateId?: string;
  assetRef?: string;
  /**
   * 终态留影：实时帧流里最后一帧的 JPEG dataUrl（仅内存，不持久化、不跨 reload）。
   * 停流时状态标 'stale' 但本字段保留，BrowserAgentWindow 用它渲染置灰留影。
   */
  dataUrl?: string;
  updatedAt?: number;
  error?: string;
}

interface SurfaceEvidenceRequestStateV1 {
  evidenceId: SurfaceEvidenceCardV1['evidenceId'];
  status: 'pending' | 'ready' | 'failed';
  requestId?: string;
  startedAt?: number;
  settledAt?: number;
  error?: string;
}

interface SurfaceEvidenceScopeStateV1 {
  scope: SurfaceExecutionScopeV1;
  requests: Record<string, SurfaceEvidenceRequestStateV1>;
}

interface SurfaceControlRequestStateV1 {
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
  setNativeSnapshot: (conversationId: string, snapshot: unknown) => SurfaceSnapshotApplyResultV1;
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

/**
 * B1-R：某个会话当前活着的 **browser** surface 会话。
 *
 * 与 selectSurfaceExecutionRunSessionV1 的区别是它按 surface 类型收窄——会话里同时
 * 跑 computer surface 时，前者会把 computer 会话选出来，拿去开浏览器帧流就选错了对象。
 * 终态（completed/failed）一律不返回：浏览器现场不该给已经收工的会话继续开流。
 */
export function selectActiveBrowserSurfaceSessionV1(
  sessionsByScope: Record<string, RendererSurfaceSessionProjectionV1>,
  conversationId: string | null,
): RendererSurfaceSessionProjectionV1 | null {
  const scopedConversationId = conversationId?.trim();
  if (!scopedConversationId) return null;
  return Object.values(sessionsByScope)
    .filter((candidate) => (
      candidate.scope.conversationId === scopedConversationId
      && sessionOwnsScope(candidate)
      && candidate.session.surface === 'browser'
      && !TERMINAL_SURFACE_SESSION_STATES.has(candidate.session.state)
    ))
    .sort((left, right) => (
      right.updatedAt - left.updatedAt
      || right.session.heartbeatAt - left.session.heartbeatAt
      || right.session.startedAt - left.session.startedAt
      || surfaceExecutionScopeKeyV1(right.scope).localeCompare(surfaceExecutionScopeKeyV1(left.scope))
    ))[0] ?? null;
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
    if (projection.mode !== 'native') return 'invalid';
    const current = get().nativeByConversation[conversationId];
    // 旧快照不覆盖新快照（正确的并发保护，勿动）；但丢弃必须有出口：
    // 返回 'stale' 并留一条 debug 日志，调用方才能分辨「这次刷新其实没落地」。
    if (current && projection.updatedAt < current.updatedAt) {
      logger.debug('Discarded stale native Surface snapshot', {
        conversationId,
        discardedUpdatedAt: projection.updatedAt,
        currentUpdatedAt: current.updatedAt,
      });
      return 'stale';
    }
    set((state) => {
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
    return 'applied';
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
