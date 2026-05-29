import { describe, it, expect, beforeEach } from 'vitest';
import { useWorkflowStore } from '@renderer/stores/workflowStore';
import type { ScriptRunEvent, WorkflowLaunchRequest } from '@shared/contract/scriptRun';

const ev = (runId: string, type: ScriptRunEvent['type'], ts: number, data?: Record<string, unknown>): ScriptRunEvent => ({
  runId,
  type,
  ts,
  data,
});

beforeEach(() => {
  useWorkflowStore.getState().clear();
});

describe('workflowStore', () => {
  it('handleEvent 按 runId 建立并累积快照', () => {
    const store = useWorkflowStore.getState();
    store.handleEvent(ev('wf-1', 'run:start', 1000, { goal: '调研 X', scriptHash: 'h' }));
    store.handleEvent(ev('wf-1', 'run:phase', 1100, { title: 'decompose' }));
    store.handleEvent(ev('wf-1', 'agent:start', 1200, { agentId: 'wf-1-a1', label: 'find', phase: 'decompose' }));

    const snap = useWorkflowStore.getState().runs['wf-1'];
    expect(snap).toBeDefined();
    expect(snap.status).toBe('running');
    expect(snap.goal).toBe('调研 X');
    expect(snap.phases).toEqual(['decompose']);
    expect(snap.agents).toHaveLength(1);
    expect(snap.runningCount).toBe(1);
  });

  it('run:start 把 activeRunId 指向最新 run', () => {
    const store = useWorkflowStore.getState();
    store.handleEvent(ev('wf-1', 'run:start', 1000, { scriptHash: 'h' }));
    expect(useWorkflowStore.getState().activeRunId).toBe('wf-1');
    store.handleEvent(ev('wf-2', 'run:start', 2000, { scriptHash: 'h2' }));
    expect(useWorkflowStore.getState().activeRunId).toBe('wf-2');
  });

  it('多 run 隔离：两个 run 的快照互不串扰', () => {
    const store = useWorkflowStore.getState();
    store.handleEvent(ev('wf-1', 'run:start', 1000, { scriptHash: 'h1' }));
    store.handleEvent(ev('wf-2', 'run:start', 1000, { scriptHash: 'h2' }));
    store.handleEvent(ev('wf-1', 'agent:start', 1100, { agentId: 'wf-1-a1', label: 'x' }));
    store.handleEvent(ev('wf-2', 'agent:start', 1100, { agentId: 'wf-2-a1', label: 'y' }));
    store.handleEvent(ev('wf-1', 'agent:done', 1500, { agentId: 'wf-1-a1', label: 'x' }));

    const runs = useWorkflowStore.getState().runs;
    expect(runs['wf-1'].doneCount).toBe(1);
    expect(runs['wf-1'].runningCount).toBe(0);
    expect(runs['wf-2'].doneCount).toBe(0);
    expect(runs['wf-2'].runningCount).toBe(1);
  });

  it('clear 清空所有 run', () => {
    const store = useWorkflowStore.getState();
    store.handleEvent(ev('wf-1', 'run:start', 1000, { scriptHash: 'h' }));
    store.clear();
    expect(useWorkflowStore.getState().runs).toEqual({});
    expect(useWorkflowStore.getState().activeRunId).toBeUndefined();
  });

  it('忽略缺 runId 的事件（防御脏数据）', () => {
    const store = useWorkflowStore.getState();
    store.handleEvent({ type: 'run:start', ts: 1, data: {} } as ScriptRunEvent);
    expect(Object.keys(useWorkflowStore.getState().runs)).toHaveLength(0);
  });
});

const launchReq = (id: string, status: WorkflowLaunchRequest['status'] = 'pending'): WorkflowLaunchRequest => ({
  id,
  status,
  requestedAt: 1,
  goal: 'g',
  phases: ['p'],
  estimatedAgentCalls: 3,
  fanoutSites: 1,
  writeHint: false,
  dimensions: { cost: 'c', network: 'n', contextLeak: 'l', background: 'b' },
});

describe('workflowStore 启动审批（P3b）', () => {
  it('requested 事件加入 launchRequests', () => {
    useWorkflowStore.getState().handleLaunchEvent({ type: 'requested', request: launchReq('wf-1') });
    const reqs = useWorkflowStore.getState().launchRequests;
    expect(reqs).toHaveLength(1);
    expect(reqs[0].id).toBe('wf-1');
    expect(reqs[0].status).toBe('pending');
  });

  it('approved/rejected 事件按 id 更新状态（不重复追加）', () => {
    const store = useWorkflowStore.getState();
    store.handleLaunchEvent({ type: 'requested', request: launchReq('wf-1') });
    store.handleLaunchEvent({ type: 'approved', request: launchReq('wf-1', 'approved') });
    const reqs = useWorkflowStore.getState().launchRequests;
    expect(reqs).toHaveLength(1);
    expect(reqs[0].status).toBe('approved');
  });

  it('pendingLaunchRequest 只返回 pending 的最新一条', () => {
    const store = useWorkflowStore.getState();
    store.handleLaunchEvent({ type: 'requested', request: launchReq('wf-1') });
    store.handleLaunchEvent({ type: 'approved', request: launchReq('wf-1', 'approved') });
    expect(useWorkflowStore.getState().pendingLaunchRequest()).toBeUndefined();
    store.handleLaunchEvent({ type: 'requested', request: launchReq('wf-2') });
    expect(useWorkflowStore.getState().pendingLaunchRequest()?.id).toBe('wf-2');
  });

  it('clear 同时清空 launchRequests', () => {
    const store = useWorkflowStore.getState();
    store.handleLaunchEvent({ type: 'requested', request: launchReq('wf-1') });
    store.clear();
    expect(useWorkflowStore.getState().launchRequests).toEqual([]);
  });
});

const launchReqS = (id: string, sessionId?: string): WorkflowLaunchRequest => ({
  ...launchReq(id),
  sessionId,
});

describe('workflowStore 会话隔离（Codex Round1 HIGH#1）', () => {
  it('pendingLaunchRequest(sessionId) 只返回该会话的请求，别的会话不串', () => {
    const store = useWorkflowStore.getState();
    store.handleLaunchEvent({ type: 'requested', request: launchReqS('wf-A', 'sess-A') });
    store.handleLaunchEvent({ type: 'requested', request: launchReqS('wf-B', 'sess-B') });
    expect(useWorkflowStore.getState().pendingLaunchRequest('sess-A')?.id).toBe('wf-A');
    expect(useWorkflowStore.getState().pendingLaunchRequest('sess-B')?.id).toBe('wf-B');
  });

  it('sessionId 缺失（dev/headless 注入）的请求对任意当前会话可见', () => {
    useWorkflowStore.getState().handleLaunchEvent({ type: 'requested', request: launchReqS('wf-x', undefined) });
    expect(useWorkflowStore.getState().pendingLaunchRequest('sess-A')?.id).toBe('wf-x');
  });

  // ── Codex Round2 HIGH#1：当前会话未知（启动/切换空窗）时，会话绑定的请求 fail-closed 隐藏 ──
  it('会话绑定请求在 currentSessionId 未知时不暴露（fail-closed，不 fail-open）', () => {
    useWorkflowStore.getState().handleLaunchEvent({ type: 'requested', request: launchReqS('wf-A', 'sess-A') });
    expect(useWorkflowStore.getState().pendingLaunchRequest(undefined)).toBeUndefined();
  });

  it('activeSnapshot(sessionId) 只返回该会话的 run', () => {
    const store = useWorkflowStore.getState();
    store.handleEvent({ runId: 'rA', type: 'run:start', ts: 1, sessionId: 'sess-A', data: { scriptHash: 'h' } } as ScriptRunEvent);
    expect(useWorkflowStore.getState().activeSnapshot('sess-B')).toBeUndefined();
    expect(useWorkflowStore.getState().activeSnapshot('sess-A')?.runId).toBe('rA');
  });

  // ── Codex Round3 HIGH：run:start 丢失，只来 agent:start，activeSnapshot 仍要能选中 ──
  it('run:start 丢失时只凭 agent:start 也能被 activeSnapshot 选中（已提升 running）', () => {
    useWorkflowStore.getState().handleEvent(
      { runId: 'rA', type: 'agent:start', ts: 1, sessionId: 'sess-A', data: { agentId: 'a1', label: 'x' } } as ScriptRunEvent,
    );
    expect(useWorkflowStore.getState().activeSnapshot('sess-A')?.runId).toBe('rA');
  });
});

describe('workflowStore 容量上限（Codex Round3 MED）', () => {
  it('完成的 run 超过上限时被裁剪，不无限累积', () => {
    const store = useWorkflowStore.getState();
    for (let i = 0; i < 80; i++) {
      const id = `r${i}`;
      store.handleEvent({ runId: id, type: 'run:start', ts: i, sessionId: 's', data: {} } as ScriptRunEvent);
      store.handleEvent({ runId: id, type: 'run:done', ts: i + 1, sessionId: 's', data: { result: 1 } } as ScriptRunEvent);
    }
    expect(Object.keys(useWorkflowStore.getState().runs).length).toBeLessThanOrEqual(50);
  });

  it('已决审批请求超过上限时被裁剪', () => {
    const store = useWorkflowStore.getState();
    for (let i = 0; i < 40; i++) {
      store.handleLaunchEvent({ type: 'requested', request: launchReq(`wf${i}`) });
      store.handleLaunchEvent({ type: 'approved', request: launchReq(`wf${i}`, 'approved') });
    }
    expect(useWorkflowStore.getState().launchRequests.length).toBeLessThanOrEqual(20);
  });

  // ── Codex Round4 MED：很老的 pending 刚被 resolve 不应立刻被裁（按 resolve 时序保留最近）──
  it('老 pending 刚 resolve 时不被裁掉（移到尾部按最近保留）', () => {
    const store = useWorkflowStore.getState();
    store.handleLaunchEvent({ type: 'requested', request: launchReq('wf-old') }); // 最早的 pending
    for (let i = 0; i < 25; i++) {
      store.handleLaunchEvent({ type: 'requested', request: launchReq(`wf${i}`) });
      store.handleLaunchEvent({ type: 'approved', request: launchReq(`wf${i}`, 'approved') });
    }
    // 此刻 wf-old 仍 pending（pending 永不裁）；现在它 resolve
    store.handleLaunchEvent({ type: 'approved', request: launchReq('wf-old', 'approved') });
    const ids = useWorkflowStore.getState().launchRequests.map((r) => r.id);
    expect(ids).toContain('wf-old'); // 刚 resolve 的不应立刻消失
  });
});
