// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  SurfaceEvidenceCardV1,
  SurfaceSessionStateV1,
} from '../../../src/shared/contract/surfaceExecution';
import type { RendererSurfaceSessionProjectionV1 } from '../../../src/renderer/utils/surfaceExecutionProjection';
import { surfaceExecutionScopeKeyV1 } from '../../../src/renderer/utils/surfaceExecutionProjection';

const native = vi.hoisted(() => ({
  available: true,
  invoke: vi.fn(),
}));

const nativeEvents = vi.hoisted(() => ({
  handler: null as null | ((event: { payload: unknown }) => void),
  unlisten: vi.fn(),
}));

const surfaceControl = vi.hoisted(() => ({
  execute: vi.fn(),
}));

const surfaceFrame = vi.hoisted(() => ({
  get: vi.fn(),
}));

vi.mock('../../../src/renderer/services/nativeCommandFacade', () => ({
  isNativeCommandRuntimeAvailable: () => native.available,
  invokeNativeCommandAction: (...args: unknown[]) => native.invoke(...args),
}));

vi.mock('../../../src/renderer/services/tauriPluginFacade', () => ({
  listenTauriEvent: vi.fn(async (_event: string, handler: (event: { payload: unknown }) => void) => {
    nativeEvents.handler = handler;
    return nativeEvents.unlisten;
  }),
}));

vi.mock('../../../src/renderer/services/surfaceExecutionController', () => ({
  executeSurfaceExecutionControl: (...args: unknown[]) => surfaceControl.execute(...args),
}));

vi.mock('../../../src/renderer/services/surfaceExecutionClient', () => ({
  getSurfaceExecutionFrame: (...args: unknown[]) => surfaceFrame.get(...args),
}));

import {
  createSurfaceExecutionPipRequestFenceV1,
  isReadableSurfacePipAssetRef,
  resolveSurfaceExecutionPipDataUrlV1,
  selectSurfaceExecutionPipFrameV1,
  useSurfaceExecutionPip,
} from '../../../src/renderer/hooks/useSurfaceExecutionPip';
import { useSessionStore } from '../../../src/renderer/stores/sessionStore';
import { useSurfaceExecutionStore } from '../../../src/renderer/stores/surfaceExecutionStore';

function evidence(
  id: string,
  assetRef: string,
  overrides: Partial<SurfaceEvidenceCardV1> = {},
): SurfaceEvidenceCardV1 {
  return {
    version: 1,
    evidenceId: id,
    kind: 'screenshot',
    source: 'browser',
    title: `Frame ${id}`,
    capturedAt: 2_000,
    assetRef,
    redactionStatus: 'clean',
    inspection: {
      captureState: 'captured',
      analysisState: 'analyzed',
      verificationState: 'not_requested',
      supportsStepIds: [],
      checklist: [],
    },
    ...overrides,
  };
}

function session(input: {
  id: string;
  conversationId: string;
  updatedAt: number;
  assetRef?: string;
  state?: SurfaceSessionStateV1;
  surface?: 'browser' | 'computer';
  evidenceOverrides?: Partial<SurfaceEvidenceCardV1>;
  availableControls?: RendererSurfaceSessionProjectionV1['availableControls'];
}): RendererSurfaceSessionProjectionV1 {
  const surface = input.surface ?? 'browser';
  const scope = {
    conversationId: input.conversationId,
    runId: `run-${input.id}`,
    agentId: `agent-${input.id}`,
    surfaceSessionId: `surface-${input.id}`,
  };
  return {
    version: 1,
    scope,
    session: {
      version: 1,
      sessionId: scope.surfaceSessionId,
      runId: scope.runId,
      conversationId: scope.conversationId,
      agentId: scope.agentId,
      surface,
      provider: surface === 'browser' ? 'managed' : 'cua-driver',
      capabilities: {
        version: 1,
        surface,
        provider: surface === 'browser' ? 'managed' : 'cua-driver',
        protocolVersion: '2',
        operations: ['observe'],
        observationKinds: ['screenshot'],
        supports: {
          cancel: true,
          pause: true,
          takeover: true,
          cleanup: true,
          successorObservation: true,
        },
      },
      state: input.state ?? 'running',
      startedAt: 1_000,
      heartbeatAt: input.updatedAt,
    },
    grant: { state: 'active', capabilities: ['observe'], actionClasses: ['read'], dataScopes: [] },
    events: [],
    evidence: input.assetRef
      ? [evidence(`evidence-${input.id}`, input.assetRef, input.evidenceOverrides)]
      : [],
    outputs: [],
    availableControls: input.availableControls ?? ['pause', 'stop'],
    source: 'live',
    writable: true,
    updatedAt: input.updatedAt,
  };
}

function sessionMap(...sessions: RendererSurfaceSessionProjectionV1[]) {
  return Object.fromEntries(sessions.map((item) => [surfaceExecutionScopeKeyV1(item.scope), item]));
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

beforeEach(() => {
  native.available = true;
  native.invoke.mockReset();
  nativeEvents.handler = null;
  nativeEvents.unlisten.mockReset();
  surfaceControl.execute.mockReset();
  surfaceControl.execute.mockResolvedValue(undefined);
  surfaceFrame.get.mockReset();
  surfaceFrame.get.mockResolvedValue({
    version: 1,
    assetRef: 'surface-frame://frame-1',
    mimeType: 'image/png',
    dataUrl: 'data:image/png;base64,opaque-frame',
    bytes: 12,
    sha256: 'a'.repeat(64),
  });
  native.invoke.mockImplementation(async (action: string, payload?: { path?: string }) => {
    if (action === 'readAppshotImageDataUrl') {
      return `data:image/png;base64,read:${payload?.path ?? ''}`;
    }
    return undefined;
  });
  useSurfaceExecutionStore.getState().reset();
  useSessionStore.setState({ currentSessionId: null });
});

afterEach(() => {
  cleanup();
});

describe('selectSurfaceExecutionPipFrameV1', () => {
  it('selects only the newest active Surface Session in the current conversation', () => {
    const older = session({
      id: 'older',
      conversationId: 'conversation-a',
      updatedAt: 10,
      assetRef: 'data:image/png;base64,older',
      surface: 'computer',
    });
    const current = session({
      id: 'current',
      conversationId: 'conversation-a',
      updatedAt: 20,
      assetRef: 'data:image/png;base64,current',
    });
    const foreign = session({
      id: 'foreign',
      conversationId: 'conversation-b',
      updatedAt: 30,
      assetRef: 'data:image/png;base64,foreign',
    });
    const sessionsByScope = sessionMap(older, current, foreign);

    expect(selectSurfaceExecutionPipFrameV1({
      currentConversationId: 'conversation-a',
      sessionsByScope,
      frameByScope: {},
    })).toMatchObject({ assetRef: 'data:image/png;base64,current', surface: 'browser' });
    expect(selectSurfaceExecutionPipFrameV1({
      currentConversationId: 'conversation-b',
      sessionsByScope,
      frameByScope: {},
    })).toMatchObject({ assetRef: 'data:image/png;base64,foreign' });
  });

  it('does not fall back to another session when the current active session has no readable frame', () => {
    const readable = session({
      id: 'readable',
      conversationId: 'conversation-a',
      updatedAt: 10,
      assetRef: '/private/tmp/older.png',
    });
    const latest = session({ id: 'latest', conversationId: 'conversation-a', updatedAt: 20 });

    expect(selectSurfaceExecutionPipFrameV1({
      currentConversationId: 'conversation-a',
      sessionsByScope: sessionMap(readable, latest),
      frameByScope: {},
    })).toBeNull();
  });

  it('hides terminal, blocked, redacted, and canary-backed frames', () => {
    const completed = session({
      id: 'completed',
      conversationId: 'conversation-a',
      updatedAt: 10,
      state: 'completed',
      assetRef: 'data:image/png;base64,done',
    });
    const blocked = session({
      id: 'blocked',
      conversationId: 'conversation-b',
      updatedAt: 20,
      assetRef: '/private/tmp/blocked.png',
      evidenceOverrides: { redactionStatus: 'blocked' },
    });
    const redacted = session({
      id: 'redacted',
      conversationId: 'conversation-c',
      updatedAt: 30,
      assetRef: '/private/tmp/redacted.png',
      evidenceOverrides: { redactionStatus: 'redacted' },
    });
    const canary = session({
      id: 'canary',
      conversationId: 'conversation-d',
      updatedAt: 40,
      assetRef: '/private/tmp/surface-secret-canary-frame.png',
    });

    for (const [conversationId, item] of [
      ['conversation-a', completed],
      ['conversation-b', blocked],
      ['conversation-c', redacted],
      ['conversation-d', canary],
    ] as const) {
      expect(selectSurfaceExecutionPipFrameV1({
        currentConversationId: conversationId,
        sessionsByScope: sessionMap(item),
        frameByScope: {},
      })).toBeNull();
    }
  });

  it('uses a ready frame state for both Browser and Computer but rejects known unsafe evidence refs', () => {
    const browser = session({ id: 'browser', conversationId: 'conversation-a', updatedAt: 10 });
    const browserKey = surfaceExecutionScopeKeyV1(browser.scope);
    expect(selectSurfaceExecutionPipFrameV1({
      currentConversationId: 'conversation-a',
      sessionsByScope: sessionMap(browser),
      frameByScope: {
        [browserKey]: {
          scope: browser.scope,
          status: 'ready',
          assetRef: 'data:image/png;base64,frame-state',
          updatedAt: 11,
        },
      },
    })).toMatchObject({ assetRef: 'data:image/png;base64,frame-state' });

    const unsafe = session({
      id: 'unsafe',
      conversationId: 'conversation-b',
      updatedAt: 20,
      assetRef: '/private/tmp/unsafe.png',
      evidenceOverrides: { redactionStatus: 'blocked' },
    });
    const unsafeKey = surfaceExecutionScopeKeyV1(unsafe.scope);
    expect(selectSurfaceExecutionPipFrameV1({
      currentConversationId: 'conversation-b',
      sessionsByScope: sessionMap(unsafe),
      frameByScope: {
        [unsafeKey]: {
          scope: unsafe.scope,
          status: 'ready',
          assetRef: '/private/tmp/unsafe.png',
        },
      },
    })).toBeNull();
  });

  it('rejects a frame whose stored scope belongs to another concurrent session', () => {
    const owner = session({ id: 'owner', conversationId: 'conversation-a', updatedAt: 20 });
    const foreign = session({ id: 'foreign', conversationId: 'conversation-b', updatedAt: 30 });
    const ownerKey = surfaceExecutionScopeKeyV1(owner.scope);

    expect(selectSurfaceExecutionPipFrameV1({
      currentConversationId: 'conversation-a',
      sessionsByScope: sessionMap(owner, foreign),
      frameByScope: {
        [ownerKey]: {
          scope: foreign.scope,
          status: 'ready',
          assetRef: 'data:image/png;base64,foreign',
        },
      },
    })).toBeNull();
  });
});

describe('Surface PiP asset and request fencing', () => {
  it('invalidates old scopes and cleared requests', () => {
    const fence = createSurfaceExecutionPipRequestFenceV1();
    const first = fence.issue('conversation-a/surface-a/frame-1');
    expect(fence.isCurrent(first)).toBe(true);
    const second = fence.issue('conversation-b/surface-b/frame-1');
    expect(fence.isCurrent(first)).toBe(false);
    expect(fence.isCurrent(second)).toBe(true);
    fence.clear();
    expect(fence.isCurrent(second)).toBe(false);
  });

  it('passes data images directly and reads local file paths through the native reader', async () => {
    const readFile = vi.fn(async () => 'data:image/png;base64,from-file');
    await expect(resolveSurfaceExecutionPipDataUrlV1(
      'data:image/png;base64,direct',
      readFile,
    )).resolves.toBe('data:image/png;base64,direct');
    expect(readFile).not.toHaveBeenCalled();

    await expect(resolveSurfaceExecutionPipDataUrlV1('/private/tmp/frame.png', readFile))
      .resolves.toBe('data:image/png;base64,from-file');
    expect(readFile).toHaveBeenCalledWith('/private/tmp/frame.png');
    expect(isReadableSurfacePipAssetRef('https://example.test/frame.png')).toBe(false);
    expect(isReadableSurfacePipAssetRef('data:image/svg+xml;base64,unsafe')).toBe(false);
    expect(isReadableSurfacePipAssetRef('surface-frame://frame-1')).toBe(true);
  });
});

describe('useSurfaceExecutionPip', () => {
  it('resolves an opaque frame through the owner-scoped Surface domain', async () => {
    const browser = session({
      id: 'opaque-frame',
      conversationId: 'conversation-a',
      updatedAt: 10,
      assetRef: 'surface-frame://frame-1',
    });
    useSurfaceExecutionStore.setState({ sessionsByScope: sessionMap(browser) });
    useSessionStore.setState({ currentSessionId: 'conversation-a' });
    const view = renderHook(() => useSurfaceExecutionPip());

    await waitFor(() => expect(surfaceFrame.get).toHaveBeenCalledWith({
      version: 1,
      conversationId: 'conversation-a',
      surfaceSessionId: browser.scope.surfaceSessionId,
      assetRef: 'surface-frame://frame-1',
    }));
    await waitFor(() => expect(native.invoke).toHaveBeenCalledWith('framePip', {
      dataUrl: 'data:image/png;base64,opaque-frame',
    }));
    expect(native.invoke).not.toHaveBeenCalledWith('readAppshotImageDataUrl', expect.anything());
    view.unmount();
  });

  it('projects actual controls and only executes an exact current owner-scoped PiP intent', async () => {
    const browser = session({
      id: 'browser-controls',
      conversationId: 'conversation-a',
      updatedAt: 10,
      assetRef: 'data:image/png;base64,browser-controls',
      availableControls: ['pause', 'takeover', 'stop'],
    });
    useSurfaceExecutionStore.setState({ sessionsByScope: sessionMap(browser) });
    useSessionStore.setState({ currentSessionId: 'conversation-a' });
    const view = renderHook(() => useSurfaceExecutionPip());

    await waitFor(() => expect(native.invoke).toHaveBeenCalledWith('setPipControls', {
      controls: expect.objectContaining({
        scope: browser.scope,
        state: 'running',
        availableControls: ['pause', 'takeover', 'stop'],
      }),
    }));
    await waitFor(() => expect(nativeEvents.handler).not.toBeNull());

    act(() => nativeEvents.handler?.({
      payload: {
        version: 1,
        scope: { ...browser.scope, agentId: 'agent-attacker' },
        action: 'pause',
      },
    }));
    expect(surfaceControl.execute).not.toHaveBeenCalled();

    act(() => nativeEvents.handler?.({
      payload: { version: 1, scope: browser.scope, action: 'resume' },
    }));
    expect(surfaceControl.execute).not.toHaveBeenCalled();

    act(() => nativeEvents.handler?.({
      payload: { version: 1, scope: browser.scope, action: 'pause' },
    }));
    expect(surfaceControl.execute).toHaveBeenCalledWith({
      version: 1,
      conversationId: 'conversation-a',
      surfaceSessionId: 'surface-browser-controls',
      action: 'pause',
    });
    view.unmount();
    expect(nativeEvents.unlisten).toHaveBeenCalled();
  });

  it('switches Browser and Computer frames by current conversation and hides terminal sessions', async () => {
    const browser = session({
      id: 'browser',
      conversationId: 'conversation-a',
      updatedAt: 10,
      assetRef: 'data:image/png;base64,browser',
    });
    const computer = session({
      id: 'computer',
      conversationId: 'conversation-b',
      updatedAt: 20,
      assetRef: 'data:image/png;base64,computer',
      surface: 'computer',
    });
    useSurfaceExecutionStore.setState({ sessionsByScope: sessionMap(browser, computer) });
    useSessionStore.setState({ currentSessionId: 'conversation-a' });
    const view = renderHook(() => useSurfaceExecutionPip());

    await waitFor(() => expect(native.invoke).toHaveBeenCalledWith('framePip', {
      dataUrl: 'data:image/png;base64,browser',
    }));
    act(() => useSessionStore.setState({ currentSessionId: 'conversation-b' }));
    await waitFor(() => expect(native.invoke).toHaveBeenCalledWith('framePip', {
      dataUrl: 'data:image/png;base64,computer',
    }));

    act(() => useSurfaceExecutionStore.setState((state) => ({
      sessionsByScope: {
        ...state.sessionsByScope,
        [surfaceExecutionScopeKeyV1(computer.scope)]: {
          ...computer,
          session: { ...computer.session, state: 'failed' },
        },
      },
    })));
    await waitFor(() => expect(native.invoke).toHaveBeenCalledWith('hidePip'));
    view.unmount();
  });

  it('does not let an old file read overwrite a newer conversation frame', async () => {
    const oldRead = deferred<string>();
    native.invoke.mockImplementation(async (action: string, payload?: { path?: string }) => {
      if (action === 'readAppshotImageDataUrl' && payload?.path === '/private/tmp/old.png') {
        return oldRead.promise;
      }
      return undefined;
    });
    const oldSession = session({
      id: 'old',
      conversationId: 'conversation-a',
      updatedAt: 10,
      assetRef: '/private/tmp/old.png',
    });
    const currentSession = session({
      id: 'current',
      conversationId: 'conversation-b',
      updatedAt: 20,
      assetRef: 'data:image/png;base64,current',
    });
    useSurfaceExecutionStore.setState({ sessionsByScope: sessionMap(oldSession, currentSession) });
    useSessionStore.setState({ currentSessionId: 'conversation-a' });
    const view = renderHook(() => useSurfaceExecutionPip());

    await waitFor(() => expect(native.invoke).toHaveBeenCalledWith(
      'readAppshotImageDataUrl',
      { path: '/private/tmp/old.png' },
    ));
    act(() => useSessionStore.setState({ currentSessionId: 'conversation-b' }));
    await waitFor(() => expect(native.invoke).toHaveBeenCalledWith('framePip', {
      dataUrl: 'data:image/png;base64,current',
    }));

    await act(async () => {
      oldRead.resolve('data:image/png;base64,stale');
      await oldRead.promise;
      await Promise.resolve();
    });
    expect(native.invoke).not.toHaveBeenCalledWith('framePip', {
      dataUrl: 'data:image/png;base64,stale',
    });
    view.unmount();
  });
});
