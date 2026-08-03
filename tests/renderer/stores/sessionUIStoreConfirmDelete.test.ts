// @vitest-environment jsdom
// sessionUIStore.confirmDelete 的终态留影内存半清理：删会话时该会话的
// frameByScope / sessionsByScope 条目必须一起清（盘上那一半由 host 收敛点负责）。
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/renderer/stores/sessionStore', () => ({
  useSessionStore: {
    getState: () => ({
      sessions: [],
      currentSessionId: null,
      loadSessions: vi.fn(),
      switchSession: vi.fn(),
    }),
    setState: vi.fn(),
  },
}));

vi.mock('../../../src/renderer/stores/appStore', () => ({
  useAppStore: {
    getState: () => ({
      syncActiveAgentForSession: vi.fn(),
      syncWorkbenchForSession: vi.fn(),
    }),
  },
}));

vi.mock('../../../src/renderer/utils/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import { useSessionUIStore } from '../../../src/renderer/stores/sessionUIStore';
import { useSurfaceExecutionStore } from '../../../src/renderer/stores/surfaceExecutionStore';
import { surfaceExecutionScopeKeyV1 } from '../../../src/renderer/utils/surfaceExecutionProjection';
import type { SurfaceExecutionScopeV1 } from '../../../src/renderer/utils/surfaceExecutionProjection';
import type { SurfaceConversationSnapshotV1 } from '../../../src/shared/contract/surfaceExecution';

function scopeFor(conversationId: string): SurfaceExecutionScopeV1 {
  return {
    conversationId,
    runId: `run-${conversationId}`,
    agentId: 'agent-a',
    surfaceSessionId: 'surface-1',
  };
}

function seedSurfaceState(conversationId: string): void {
  const snapshot: SurfaceConversationSnapshotV1 = {
    version: 1,
    conversationId,
    sessions: [{
      version: 1,
      session: {
        version: 1,
        sessionId: 'surface-1',
        conversationId,
        runId: `run-${conversationId}`,
        agentId: 'agent-a',
        surface: 'browser',
        provider: 'managed',
        capabilities: {
          version: 1,
          surface: 'browser',
          provider: 'managed',
          protocolVersion: '2',
          operations: ['observe'],
          observationKinds: ['screenshot'],
          supports: {
            cancel: true,
            pause: false,
            takeover: true,
            cleanup: true,
            successorObservation: false,
          },
        },
        state: 'completed',
        startedAt: 1_000,
        heartbeatAt: 61_000,
      },
      grant: { state: 'none', capabilities: [], actionClasses: [], dataScopes: [] },
      events: [],
      evidence: [],
      outputs: [],
      availableControls: [],
      source: 'persisted',
      writable: false,
      updatedAt: 61_000,
    }],
    updatedAt: 61_000,
  };
  useSurfaceExecutionStore.getState().setNativeSnapshot(conversationId, snapshot);
  useSurfaceExecutionStore.getState().setFrameState(scopeFor(conversationId), {
    status: 'stale',
    dataUrl: 'data:image/jpeg;base64,/9j/4AAQSkZJRg==',
  });
}

describe('sessionUIStore.confirmDelete - 终态留影内存半跟会话一起删', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useSessionUIStore.setState({ pendingDelete: null });
    useSurfaceExecutionStore.getState().reset();
    (window as unknown as Record<string, unknown>).domainAPI = {
      invoke: vi.fn(async () => ({ success: true, data: null })),
    };
  });

  it('confirmDelete 后该会话的 frameByScope / sessionsByScope 被清，别的会话保留', async () => {
    seedSurfaceState('session-a');
    seedSurfaceState('session-b');
    const keyA = surfaceExecutionScopeKeyV1(scopeFor('session-a'));
    const keyB = surfaceExecutionScopeKeyV1(scopeFor('session-b'));
    expect(useSurfaceExecutionStore.getState().frameByScope[keyA]).toBeTruthy();
    expect(useSurfaceExecutionStore.getState().sessionsByScope[keyA]).toBeTruthy();

    useSessionUIStore.setState({ pendingDelete: { ids: ['session-a'], timer: null } });
    await useSessionUIStore.getState().confirmDelete();

    const state = useSurfaceExecutionStore.getState();
    expect(state.frameByScope[keyA]).toBeUndefined();
    expect(state.sessionsByScope[keyA]).toBeUndefined();
    expect(state.nativeByConversation['session-a']).toBeUndefined();
    expect(state.frameByScope[keyB]).toBeTruthy();
    expect(state.sessionsByScope[keyB]).toBeTruthy();
    expect(state.nativeByConversation['session-b']).toBeTruthy();
  });

  it('host 删除失败时不清内存帧（帧只跟确认删掉的会话走）', async () => {
    seedSurfaceState('session-a');
    const keyA = surfaceExecutionScopeKeyV1(scopeFor('session-a'));
    (window as unknown as Record<string, unknown>).domainAPI = {
      invoke: vi.fn(async () => ({ success: false, error: { message: 'db locked' } })),
    };

    useSessionUIStore.setState({ pendingDelete: { ids: ['session-a'], timer: null } });
    await useSessionUIStore.getState().confirmDelete();

    expect(useSurfaceExecutionStore.getState().frameByScope[keyA]).toBeTruthy();
  });
});
