// @vitest-environment jsdom
// 停下一次自动续跑之后，发送键必须停在「继续」。
// 组合方式与 ChatView 相同：useSessionTurnActive → useDurableContinueVisible → SendButton。
import React from 'react';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '../../../src/shared/contract';
import { projectDurableRunToSessionPayload, type DurableRunView } from '../../../src/host/app/durableRunReadService';
import { IPC_CHANNELS } from '../../../src/shared/ipc';
import { SendButton } from '../../../src/renderer/components/features/chat/ChatInput/SendButton';
import { useDurableContinueVisible } from '../../../src/renderer/components/features/chat/durableResume';
import { useSessionTurnActive } from '../../../src/renderer/hooks/useSessionTurnActive';
import { useAppStore } from '../../../src/renderer/stores/appStore';
import { initializeSessionStore, useSessionStore } from '../../../src/renderer/stores/sessionStore';
import { useTaskStore } from '../../../src/renderer/stores/taskStore';

const SESSION_ID = 'auto-resume-stopped';
const RUN_ID = 'run-auto-resume-stopped';
const PARKED_UPDATED_AT = 2_000;
const STALE_UPDATED_AT = 1_000;
const RESUMED_UPDATED_AT = 3_000;

const ipcListeners = new Map<string, Set<(payload: unknown) => void>>();
const mockDomainInvoke = vi.fn();
const mockInvoke = vi.fn(async () => undefined);

type ListMode = 'parked' | 'stale-auto-resuming' | 'resumed-running';
let listMode: ListMode = 'parked';
let loadActiveRun = false;
let loadStatusOverride: Session['status'] | undefined;

function recordOn(channel: string, callback: (payload: unknown) => void): () => void {
  const bucket = ipcListeners.get(channel) ?? new Set<(payload: unknown) => void>();
  bucket.add(callback);
  ipcListeners.set(channel, bucket);
  return () => bucket.delete(callback);
}

function installBridge(): void {
  const bridge = { invoke: mockInvoke, on: recordOn, off: () => undefined };
  Object.assign(window, {
    domainAPI: { invoke: mockDomainInvoke },
    codeAgentAPI: bridge,
    electronAPI: bridge,
  });
}

function parkedView(): DurableRunView {
  return {
    source: 'durable',
    consumer: 'session_replay',
    runId: RUN_ID,
    sessionId: SESSION_ID,
    status: 'waiting',
    engine: { kind: 'native' },
    terminal: false,
    interruptCause: 'user_stop',
    autoResumeCount: 1,
    continuable: true,
  };
}

function autoResumingView(): DurableRunView {
  return {
    source: 'durable',
    consumer: 'session_replay',
    runId: RUN_ID,
    sessionId: SESSION_ID,
    status: 'running',
    engine: { kind: 'native' },
    terminal: false,
    attempt: 2,
    interruptCause: 'crash_or_quit',
    autoResumeCount: 1,
    continuable: true,
  };
}

function freshRunningView(): DurableRunView {
  return {
    source: 'durable',
    consumer: 'session_replay',
    runId: RUN_ID,
    sessionId: SESSION_ID,
    status: 'running',
    engine: { kind: 'native' },
    terminal: false,
    attempt: 1,
    autoResumeCount: 0,
    continuable: true,
  };
}

function sessionRow(
  projection: ReturnType<typeof projectDurableRunToSessionPayload>,
  updatedAt: number,
): Session {
  return {
    id: SESSION_ID,
    title: '已停下的续跑',
    modelConfig: { provider: 'zhipu', model: 'glm-5' },
    createdAt: 1,
    updatedAt,
    messageCount: 1,
    turnCount: 1,
    ...projection,
  } as Session;
}

function parkedSession(): Session {
  return sessionRow(projectDurableRunToSessionPayload(parkedView()), PARKED_UPDATED_AT);
}

function staleAutoResumingSession(): Session {
  return sessionRow(projectDurableRunToSessionPayload(autoResumingView()), STALE_UPDATED_AT);
}

function resumedRunningSession(): Session {
  return sessionRow(projectDurableRunToSessionPayload(freshRunningView()), RESUMED_UPDATED_AT);
}

function emit(channel: string, payload: unknown): void {
  const bucket = ipcListeners.get(channel);
  if (!bucket || bucket.size === 0) {
    throw new Error(`no ${channel} listener`);
  }
  for (const callback of bucket) callback(payload);
}

function settleStoppedRun(): void {
  useAppStore.getState().setSessionProcessing(SESSION_ID, false);
  useTaskStore.getState().updateSessionState(SESSION_ID, { status: 'cancelled' });
  useTaskStore.getState().updateSessionState(SESSION_ID, { status: 'idle' });
  useSessionStore.setState({
    currentSessionId: SESSION_ID,
    sessions: [parkedSession()] as ReturnType<typeof useSessionStore.getState>['sessions'],
    runningSessionIds: new Set<string>(),
    sessionRuntimes: new Map(),
    messages: [],
    todos: [],
    sessionTasks: [],
    streamSnapshot: null,
    isLoading: false,
    isHydratingSession: false,
    error: null,
  });
}

function SendKey({ sessionId }: { sessionId: string }) {
  const durableResume = useSessionStore((state) => (
    state.sessions.find((session) => session.id === sessionId)?.durableResume
  ));
  const turnActive = useSessionTurnActive(sessionId);
  const showContinue = useDurableContinueVisible(durableResume, turnActive);
  return (
    <SendButton
      hasContinuation={showContinue}
      isProcessing={turnActive}
      onContinue={() => undefined}
      onStop={() => undefined}
    />
  );
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

function expectContinueNow(): void {
  expect(screen.getByTestId('continue-run-button').textContent).toMatch(/继续|Continue/);
  expect(screen.queryByRole('button', { name: /停止|Stop/ })).toBeNull();
}

async function expectContinueFor(ms: number): Promise<void> {
  expectContinueNow();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
  await flush();
  expectContinueNow();
}

describe('send key after stopping an auto-resumed run', () => {
  beforeAll(async () => {
    installBridge();
    mockDomainInvoke.mockImplementation(async (_domain: string, action: string, payload?: { sessionId?: string }) => {
      if (action === 'list') {
        const row = listMode === 'stale-auto-resuming'
          ? staleAutoResumingSession()
          : listMode === 'resumed-running'
            ? resumedRunningSession()
            : parkedSession();
        return { success: true, data: [row] };
      }
      if (action === 'load') {
        const base = parkedSession();
        return {
          success: true,
          data: {
            ...base,
            id: payload?.sessionId ?? SESSION_ID,
            messages: [],
            todos: [],
            activeRun: loadActiveRun,
            ...(loadStatusOverride ? { status: loadStatusOverride } : {}),
          },
        };
      }
      if (action === 'getSessionTasks') return { success: true, data: [] };
      return { success: true, data: null };
    });
    useSessionStore.setState({
      currentSessionId: SESSION_ID,
      sessions: [parkedSession()] as ReturnType<typeof useSessionStore.getState>['sessions'],
    });
    await initializeSessionStore();
  });

  beforeEach(() => {
    listMode = 'parked';
    loadActiveRun = false;
    loadStatusOverride = undefined;
    installBridge();
    settleStoppedRun();
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'Date'] });
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('S1 keeps Continue when a running session update arrives with the parked continue projection', async () => {
    const parked = projectDurableRunToSessionPayload(parkedView());
    render(<SendKey sessionId={SESSION_ID} />);
    await flush();
    expectContinueNow();
    await act(async () => {
      emit(IPC_CHANNELS.SESSION_UPDATED, {
        sessionId: SESSION_ID,
        updates: {
          ...parked,
          status: 'running',
          updatedAt: STALE_UPDATED_AT,
        },
      });
    });
    await expectContinueFor(30_000);
  });

  it('S2 keeps Continue when switchSession reloads activeRun with a running status and continue projection', async () => {
    loadActiveRun = true;
    loadStatusOverride = 'running';
    useSessionStore.setState({ currentSessionId: null });
    render(<SendKey sessionId={SESSION_ID} />);
    await flush();
    expectContinueNow();
    await act(async () => {
      await useSessionStore.getState().switchSession(SESSION_ID);
    });
    await expectContinueFor(30_000);
  });

  it('S3 keeps Continue when the post-stop session list refresh returns the stale auto-resuming projection', async () => {
    render(<SendKey sessionId={SESSION_ID} />);
    await flush();
    expectContinueNow();
    listMode = 'stale-auto-resuming';
    await act(async () => {
      await useSessionStore.getState().loadSessions({ silent: true });
    });
    await expectContinueFor(30_000);
  });

  it('S4 keeps Continue when a session status update says the parked run is running', async () => {
    render(<SendKey sessionId={SESSION_ID} />);
    await flush();
    expectContinueNow();
    await act(async () => {
      emit(IPC_CHANNELS.SESSION_STATUS_UPDATE, {
        sessionId: SESSION_ID,
        status: 'running',
        activeAgentCount: 1,
        contextHealth: null,
      });
    });
    await expectContinueFor(30_000);
  });

  it('a parked host projection (interrupted + continue) does not light the turn', async () => {
    const parked = projectDurableRunToSessionPayload(parkedView());
    render(<SendKey sessionId={SESSION_ID} />);
    await flush();
    expectContinueNow();
    await act(async () => {
      emit(IPC_CHANNELS.SESSION_UPDATED, {
        sessionId: SESSION_ID,
        updates: { ...parked, updatedAt: PARKED_UPDATED_AT },
      });
    });
    await expectContinueFor(30_000);
  });
});
