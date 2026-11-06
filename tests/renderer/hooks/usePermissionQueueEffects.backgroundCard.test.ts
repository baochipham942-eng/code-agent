// N-SUBAGENT-APPROVAL-BUBBLE-UP-CARD-REPRO
// 后台任务（spawn_agent 子代理 / 后台 Browser 步）的审批卡与前台 run 同 sessionId：
// 前台 run 结束（agent_complete / error / stream_end）不得把后台任务的审批卡一起清掉。
// 这组测试走**生产同款接线**：applyPermissionQueueEvent + 真实 useAppStore
// （usePermissionQueueEffects.ts 里 ipcService.on('agent:event') 的 deps 组装），
// 不用 harness mock——mock 会把被测语义抄一遍，抄一遍就证明不了仓库里的真行为。
import { beforeEach, describe, expect, it } from 'vitest';
import type { PermissionRequest } from '../../../src/shared/contract';
import { useAppStore } from '../../../src/renderer/stores/appStore';
import {
  applyPermissionQueueEvent,
  type PermissionQueueEventDeps,
} from '../../../src/renderer/hooks/agent/effects/usePermissionQueueEffects';

function permissionRequest(id: string): PermissionRequest {
  return {
    id,
    type: 'command',
    tool: 'shell',
    details: { command: `echo ${id}` },
    timestamp: 100,
  };
}

/** 后台 lane 的审批请求：同 sessionId、独立 runId/agentId（subagentToolRuntime 把 identity 摊进请求）。 */
function backgroundPermissionRequest(id: string): PermissionRequest {
  return {
    ...permissionRequest(id),
    sessionId: 'session-main',
    agentId: `bg-agent-${id}`,
    runId: `bg-run-${id}`,
    parentToolUseId: `tool-${id}`,
  };
}

function createProductionDeps(currentSessionId: string | null): {
  deps: PermissionQueueEventDeps;
  unreadSessionIds: string[];
} {
  const unreadSessionIds: string[] = [];
  const deps: PermissionQueueEventDeps = {
    // 与 src/renderer/hooks/agent/effects/usePermissionQueueEffects.ts 的接线逐字同形。
    clearForegroundPermissionRequestsForSession: (sessionId) =>
      useAppStore.getState().clearForegroundPermissionRequestsForSession(sessionId),
    removePermissionRequestsForBackgroundRun: (identity) =>
      useAppStore.getState().removePermissionRequestsForBackgroundRun(identity),
    debug: () => {},
    enqueuePermissionRequest: (sessionId, request, options) =>
      useAppStore.getState().enqueuePermissionRequest(sessionId, request, options),
    getCurrentSessionId: () => currentSessionId,
    hasPermissionRequest: (requestId) => {
      const state = useAppStore.getState();
      if (state.pendingPermissionRequest?.id === requestId) return true;
      return Object.values(state.queuedPermissionRequests)
        .some((queue) => queue.some((request) => request.id === requestId));
    },
    getPendingPermissionRequest: () => useAppStore.getState().pendingPermissionRequest,
    markSessionUnread: (sessionId) => {
      unreadSessionIds.push(sessionId);
    },
    now: () => 500,
    setLastEventAt: () => {},
    setPendingPermissionRequest: (request, sessionId) =>
      useAppStore.getState().setPendingPermissionRequest(request, sessionId),
    recordPermissionDecision: useAppStore.getState().recordPermissionDecision,
    dismissPermissionRequest: useAppStore.getState().dismissPermissionRequest,
  };
  return { deps, unreadSessionIds };
}

describe('后台任务审批卡在前台 run 结束后保留（N-SUBAGENT-APPROVAL-BUBBLE-UP-CARD-REPRO）', () => {
  beforeEach(() => {
    useAppStore.setState({
      pendingPermissionRequest: null,
      pendingPermissionSessionId: null,
      queuedPermissionRequests: {},
      resolvedPermissionRequests: {},
    });
  });

  it('前台 agent_complete 后，正显示着（pending）的后台审批卡仍在，可被批准', () => {
    const { deps } = createProductionDeps('session-main');
    const bgRequest = backgroundPermissionRequest('bg-write');

    // 后台任务在用户停留在主会话时请求审批 → 直接上卡（现有 enqueue 规则）。
    applyPermissionQueueEvent(
      { type: 'permission_request', data: bgRequest, sessionId: 'session-main' },
      deps,
    );
    expect(useAppStore.getState().pendingPermissionRequest?.id).toBe('bg-write');
    expect(useAppStore.getState().pendingPermissionSessionId).toBe('session-main');

    // 前台 run 正常结束：同 sessionId 的 agent_complete。
    applyPermissionQueueEvent({ type: 'agent_complete', data: null, sessionId: 'session-main' }, deps);

    // 卡必须还在主会话里等着被点。
    expect(useAppStore.getState().pendingPermissionRequest?.id).toBe('bg-write');
    expect(useAppStore.getState().pendingPermissionSessionId).toBe('session-main');

    // 卡是可动作的：批准（PermissionCard 点击的 store 侧效果）把卡收走并落已决存证。
    const pending = useAppStore.getState().pendingPermissionRequest;
    if (!pending) throw new Error('background approval card was not pending');
    useAppStore.getState().recordPermissionDecision(pending, 'once', 'session-main');
    expect(useAppStore.getState().pendingPermissionRequest).toBeNull();
    expect(useAppStore.getState().resolvedPermissionRequests['session-main']?.[0]?.id).toBe('bg-write');
  });

  it('用户在别的会话时：后台审批进队列并标未读，前台 run 结束后队列里的卡保留', () => {
    const { deps, unreadSessionIds } = createProductionDeps('session-other');
    const bgRequest = backgroundPermissionRequest('bg-queued');

    applyPermissionQueueEvent(
      { type: 'permission_request', data: bgRequest, sessionId: 'session-main' },
      deps,
    );
    expect(useAppStore.getState().queuedPermissionRequests['session-main']?.map((r) => r.id)).toEqual(['bg-queued']);
    expect(unreadSessionIds).toEqual(['session-main']);

    applyPermissionQueueEvent({ type: 'agent_complete', data: null, sessionId: 'session-main' }, deps);

    // 队列里的后台卡保留：用户切回主会话时 reconcile 会把它晋升成 pending（现有机制）。
    expect(useAppStore.getState().queuedPermissionRequests['session-main']?.map((r) => r.id)).toEqual(['bg-queued']);
  });

  it('error / stream_end 终态事件同样不清后台审批卡', () => {
    const { deps } = createProductionDeps('session-main');
    const bgRequest = backgroundPermissionRequest('bg-error-case');
    applyPermissionQueueEvent(
      { type: 'permission_request', data: bgRequest, sessionId: 'session-main' },
      deps,
    );

    applyPermissionQueueEvent(
      { type: 'error', data: { message: 'tool failed' }, sessionId: 'session-main' },
      deps,
    );
    expect(useAppStore.getState().pendingPermissionRequest?.id).toBe('bg-error-case');

    applyPermissionQueueEvent({ type: 'stream_end', data: null, sessionId: 'session-main' }, deps);
    expect(useAppStore.getState().pendingPermissionRequest?.id).toBe('bg-error-case');
  });

  it('没有 run 身份的前台请求仍按原样在 run 结束时被清掉', () => {
    const { deps } = createProductionDeps('session-main');
    const foregroundRequest = permissionRequest('fg-echo');
    applyPermissionQueueEvent(
      { type: 'permission_request', data: { ...foregroundRequest, sessionId: 'session-main' }, sessionId: 'session-main' },
      deps,
    );
    expect(useAppStore.getState().pendingPermissionRequest?.id).toBe('fg-echo');

    applyPermissionQueueEvent({ type: 'agent_complete', data: null, sessionId: 'session-main' }, deps);

    expect(useAppStore.getState().pendingPermissionRequest).toBeNull();
    expect(useAppStore.getState().pendingPermissionSessionId).toBeNull();
  });
});

describe('后台任务自己的 run 结束 → 卡收走（stale-card guard）', () => {
  beforeEach(() => {
    useAppStore.setState({
      pendingPermissionRequest: null,
      pendingPermissionSessionId: null,
      queuedPermissionRequests: {},
      resolvedPermissionRequests: {},
    });
  });

  it.each([
    ['completed'],
    ['cancelled'],
    ['failed'],
  ] as const)('subagent_run_end(%s) 收掉该后台 lane 的 pending 与队列卡', (status) => {
    const { deps } = createProductionDeps('session-main');
    const pendingBg = backgroundPermissionRequest('bg-pending');
    // 同一条后台 lane 先后抛的两张卡：一张在 pending 槽、一张在队列里。
    const queuedBg: PermissionRequest = {
      ...backgroundPermissionRequest('bg-queued'),
      agentId: pendingBg.agentId,
      runId: pendingBg.runId,
    };
    const otherBg = backgroundPermissionRequest('bg-other-lane');
    applyPermissionQueueEvent(
      { type: 'permission_request', data: pendingBg, sessionId: 'session-main' },
      deps,
    );
    useAppStore.getState().enqueuePermissionRequest('session-main', queuedBg);
    useAppStore.getState().enqueuePermissionRequest('session-main', otherBg);

    applyPermissionQueueEvent({
      type: 'subagent_run_end',
      data: { agentId: pendingBg.agentId, runId: pendingBg.runId, status },
      sessionId: 'session-main',
    }, deps);

    // 同一 lane（runId/agentId 匹配）的卡全收；别的 lane 不受牵连。
    expect(useAppStore.getState().pendingPermissionRequest).toBeNull();
    expect(useAppStore.getState().queuedPermissionRequests['session-main']?.map((r) => r.id))
      .toEqual(['bg-other-lane']);
  });

  it('companion 在别处裁决 → 桌面卡收走（既有语义，回归钉住）', () => {
    const { deps } = createProductionDeps('session-main');
    const bgRequest = backgroundPermissionRequest('bg-companion');
    applyPermissionQueueEvent(
      { type: 'permission_request', data: bgRequest, sessionId: 'session-main' },
      deps,
    );
    expect(useAppStore.getState().pendingPermissionRequest?.id).toBe('bg-companion');

    applyPermissionQueueEvent({
      type: 'permission_request',
      data: { ...bgRequest, resolved: true, decision: 'once', resolvedBy: 'companion' },
      sessionId: 'session-main',
    }, deps);

    expect(useAppStore.getState().pendingPermissionRequest).toBeNull();
    expect(useAppStore.getState().resolvedPermissionRequests['session-main']).toBeUndefined();
  });
});
