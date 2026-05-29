import { describe, it, expect, beforeEach } from 'vitest';
import { useWorkflowStore } from '@renderer/stores/workflowStore';
import type { ScriptRunEvent } from '@shared/contract/scriptRun';

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
