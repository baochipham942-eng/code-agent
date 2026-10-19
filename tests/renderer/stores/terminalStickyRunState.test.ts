// @vitest-environment jsdom
// 终态粘滞守卫（terminal-sticky）：run 终局被 renderer 应用之后，这个 run 的
// 尾巴——hook_started / stream_end、终局前读库的 session.load 响应、开跑时的
// 旧 running 广播——不得把会话重新点亮成运行态（2026-10-16 表格卡真跑：
// agent_complete 后 7 秒 stream_end 重淋 taskStore=running，Stop/侧栏
// spinner/「正在整理回复…」三面卡死到 reload）。真跑形状取自插桩时间线：
// turn_start → … → agent_complete → hook_started → stream_end，load 每 1.5s
// 一发（streamSnapshotRehydrate force 重灌）。
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '../../../src/shared/contract';
import { IPC_CHANNELS } from '../../../src/shared/ipc';
import type { AgentEffectsProps } from '../../../src/renderer/hooks/agent/useAgentEffects';
import { useConversationStreamEffects } from '../../../src/renderer/hooks/agent/effects/useConversationStreamEffects';
import { useSessionLifecycleEffects } from '../../../src/renderer/hooks/agent/effects/useSessionLifecycleEffects';
import { initializeSessionStore, useSessionStore } from '../../../src/renderer/stores/sessionStore';
import { useAppStore } from '../../../src/renderer/stores/appStore';
import { useTaskStore } from '../../../src/renderer/stores/taskStore';
import { useTerminalRunGuardStore } from '../../../src/renderer/stores/terminalRunGuardStore';

const SESSION_ID = 'terminal-sticky-session';
const TERMINAL_STAMP = 5_000;
const STALE_LOAD_UPDATED_AT = 3_000;
const NEW_RUN_UPDATED_AT = 6_000;

const ipcListeners = new Map<string, Set<(payload: unknown) => void>>();
const mockDomainInvoke = vi.fn();
const mockInvoke = vi.fn(async () => undefined);

let loadActiveRun = false;
let loadStatus: Session['status'] = 'running';
let loadUpdatedAt: number = STALE_LOAD_UPDATED_AT;

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

function baseSession(overrides: Record<string, unknown> = {}): Session {
  return {
    id: SESSION_ID,
    title: '终态粘滞',
    modelConfig: { provider: 'zhipu', model: 'glm-5' },
    createdAt: 1,
    updatedAt: TERMINAL_STAMP,
    status: 'running',
    messageCount: 2,
    turnCount: 1,
    ...overrides,
  } as Session;
}

function emit(channel: string, payload: unknown): void {
  const bucket = ipcListeners.get(channel);
  if (!bucket || bucket.size === 0) {
    throw new Error(`no ${channel} listener`);
  }
  for (const callback of bucket) callback(payload);
}

// ipcService 对 agent 事件做 per-session seq 去重（重复/乱序直接丢），事件序号必须递增。
let agentSeq = 0;
function emitAgentEvent(event: Record<string, unknown>): void {
  agentSeq += 1;
  act(() => {
    emit('agent:event', { streamEpoch: 'http:test', seq: agentSeq, sessionId: SESSION_ID, ...event });
  });
}

function emitSessionUpdated(updates: Record<string, unknown>): void {
  act(() => {
    emit(IPC_CHANNELS.SESSION_UPDATED, { sessionId: SESSION_ID, updates });
  });
}

/** 与生产同形：事件动作落到真实 store，React 局部状态用 noop。 */
function makeEffectsProps(): AgentEffectsProps {
  const noop = () => undefined;
  return {
    addMessage: (message) => useSessionStore.getState().addMessage(message),
    appendStreamingMessageDelta: noop,
    currentSessionId: SESSION_ID,
    currentTurnMessageIdRef: { current: null },
    enqueuePermissionRequest: useAppStore.getState().enqueuePermissionRequest,
    flushRef: { current: noop },
    flushStreamingMessages: noop,
    lastEventAtRef: { current: Date.now() },
    pendingPermissionRequest: null,
    pendingPermissionSessionId: null,
    queueUpdate: noop,
    setActiveToolProgress: noop,
    setIsInterrupting: noop,
    setIsProcessing: useAppStore.getState().setIsProcessing,
    setPendingPermissionRequest: useAppStore.getState().setPendingPermissionRequest,
    setResearchDetected: noop,
    setSessionTaskComplete: useAppStore.getState().setSessionTaskComplete,
    setSessionTaskProgress: useAppStore.getState().setSessionTaskProgress,
    setSessionTasks: useSessionStore.getState().setSessionTasks,
    setTodos: useSessionStore.getState().setTodos,
    setToolTimeoutWarning: noop,
    shiftQueuedPermissionRequest: useAppStore.getState().shiftQueuedPermissionRequest,
    updateMessage: (id, updates) => useSessionStore.getState().updateMessage(id, updates),
  };
}

function mountEffects(): void {
  const props = makeEffectsProps();
  renderHook(() => {
    useConversationStreamEffects(props);
    useSessionLifecycleEffects(props);
  });
}

function resetRunState(): void {
  useTerminalRunGuardStore.setState({ terminalBySession: new Map() });
  useAppStore.setState({ processingSessionIds: new Set(), isProcessing: false });
  useTaskStore.setState({ sessionStates: {} });
  useSessionStore.setState({
    currentSessionId: SESSION_ID,
    sessions: [baseSession()] as ReturnType<typeof useSessionStore.getState>['sessions'],
    messages: [],
    todos: [],
    sessionTasks: [],
    streamSnapshot: null,
    isLoading: false,
    isHydratingSession: false,
    error: null,
  });
}

function expectIdle(): void {
  expect(useAppStore.getState().processingSessionIds.has(SESSION_ID)).toBe(false);
  expect(useTaskStore.getState().sessionStates[SESSION_ID]?.status ?? 'idle').not.toBe('running');
}

function expectRunning(): void {
  expect(useAppStore.getState().processingSessionIds.has(SESSION_ID)).toBe(true);
  expect(useTaskStore.getState().sessionStates[SESSION_ID]?.status).toBe('running');
}

describe('terminal-sticky run state（终局后不得重淋运行态）', () => {
  beforeAll(async () => {
    installBridge();
    mockDomainInvoke.mockImplementation(async (_domain: string, action: string) => {
      if (action === 'list') return { success: true, data: [baseSession()] };
      if (action === 'load') {
        return {
          success: true,
          data: baseSession({
            activeRun: loadActiveRun,
            status: loadStatus,
            updatedAt: loadUpdatedAt,
            messages: [],
            todos: [],
          }),
        };
      }
      if (action === 'getSessionTasks') return { success: true, data: [] };
      return { success: true, data: null };
    });
    await initializeSessionStore();
  });

  beforeEach(() => {
    loadActiveRun = false;
    loadStatus = 'running';
    loadUpdatedAt = STALE_LOAD_UPDATED_AT;
    installBridge();
    resetRunState();
    mountEffects();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('终局后的尾巴事件（hook_started / stream_end）不重淋运行态——FU3-FU1-FU1-FU1 真跑卡死形状', () => {
    emitAgentEvent({ type: 'turn_start', data: { turnId: 'turn-1' } });
    expectRunning();

    emitAgentEvent({ type: 'agent_complete', data: null });
    expectIdle();

    // 真跑插桩实录：agent_complete 之后 1ms 到 7s，run 自己的尾巴陆续到达。
    emitAgentEvent({ type: 'hook_started', data: { hookId: 'post-tool-cleanup' } });
    emitAgentEvent({ type: 'stream_end', data: null });
    expectIdle();
    expect(useTerminalRunGuardStore.getState().hasTerminal(SESSION_ID)).toBe(true);
  });

  it('turn_start 再武装：终局后新 run 的事件恢复点亮（追问路径）', () => {
    emitAgentEvent({ type: 'agent_complete', data: null });
    expectIdle();

    emitAgentEvent({ type: 'turn_start', data: { turnId: 'turn-2' } });
    expectRunning();
    emitAgentEvent({ type: 'model_response', data: { text: '第二轮回复' } });
    expectRunning();
  });

  it('无终局时中段事件照常点亮（C3 刷新重附着钉子）', () => {
    useAppStore.getState().setSessionProcessing(SESSION_ID, false);
    emitAgentEvent({ type: 'model_response', data: { text: '刷新后接回中段' } });
    expectRunning();
  });

  it('终局前读库的旧 load 响应（activeRun=true status=running 残影）不重淋', async () => {
    emitSessionUpdated({ status: 'completed', updatedAt: TERMINAL_STAMP });
    expectIdle();
    expect(useTerminalRunGuardStore.getState().hasTerminal(SESSION_ID)).toBe(true);

    // 旧世界的 load：读库发生在终态落库之前（updatedAt 早于终态广播戳）。
    loadActiveRun = true;
    loadStatus = 'running';
    loadUpdatedAt = STALE_LOAD_UPDATED_AT;
    await act(async () => {
      await useSessionStore.getState().switchSession(SESSION_ID, { force: true });
    });
    expectIdle();
  });

  it('无终局的 load 重附着照常点亮（刷新接回真跑钉子）', async () => {
    loadActiveRun = true;
    loadStatus = 'running';
    loadUpdatedAt = NEW_RUN_UPDATED_AT;
    await act(async () => {
      await useSessionStore.getState().switchSession(SESSION_ID, { force: true });
    });
    expectRunning();
  });

  it('终局前的旧 running 广播不重淋；新 run 的 running 广播照常', () => {
    emitSessionUpdated({ status: 'completed', updatedAt: TERMINAL_STAMP });
    expectIdle();

    emitSessionUpdated({ status: 'running', updatedAt: STALE_LOAD_UPDATED_AT });
    expectIdle();

    emitSessionUpdated({ status: 'running', updatedAt: NEW_RUN_UPDATED_AT });
    expectRunning();
  });
});
