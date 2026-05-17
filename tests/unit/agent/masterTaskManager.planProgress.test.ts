// ============================================================================
// MasterTaskManager.subscribeToPlanning — planningStateEmitter → planProgress 流
// ============================================================================
//
// 覆盖：
//   - 注册后 emit 'plan_updated' → 调 appendPlanProgress
//   - 首次（previousPlanString=''）chunk = 整段 markdown
//   - append-only 增长 → chunk 只是尾部
//   - 非 append-only（plan 改写）→ chunk 带 marker 重置
//   - 同 plan 重复 emit → 不调 appendPlanProgress（跳过）
//   - unsubscribe 后停止接收
//   - 同一 masterTaskId 重复订阅幂等（listener 只挂一次）
//   - formatPlanAsMarkdown 处理 null / 空 phases / 完整 plan
//
// 不走 DB（appendPlanProgress 在 db 不可用时只 warn 不抛），用 spyOn 验证调用。
// ============================================================================

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import {
  MasterTaskManager,
  formatPlanAsMarkdown,
} from '../../../src/main/agent/masterTaskManager';
import { planningStateEmitter } from '../../../src/main/planning/planningStatePublisher';
import type { PlanningState, TaskPlan } from '../../../src/shared/contract';

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

function makePlan(phases: Array<{ title: string; status?: string; steps?: Array<{ content: string; status?: string }> }>): TaskPlan {
  return {
    id: 'plan-1',
    title: 'test plan',
    objective: 'test',
    phases: phases.map((p, i) => ({
      id: `phase-${i}`,
      title: p.title,
       
      status: (p.status ?? 'pending') as any,
      steps: (p.steps ?? []).map((s, j) => ({
        id: `step-${i}-${j}`,
        content: s.content,
         
        status: (s.status ?? 'pending') as any,
      })),
    })),
    createdAt: 0,
    updatedAt: 0,
    metadata: { totalSteps: 0, completedSteps: 0, blockedSteps: 0 },
  };
}

function makeState(plan: TaskPlan | null): PlanningState {
  return { plan, findings: [], errors: [] };
}

// ----------------------------------------------------------------------------
// Tests
// ----------------------------------------------------------------------------

describe('formatPlanAsMarkdown', () => {
  it('returns empty string for null / undefined / empty phases', () => {
    expect(formatPlanAsMarkdown(null)).toBe('');
    expect(formatPlanAsMarkdown(undefined)).toBe('');
    expect(formatPlanAsMarkdown(makePlan([]))).toBe('');
  });

  it('serializes phases and their steps into markdown', () => {
    const plan = makePlan([
      { title: 'phase A', status: 'in_progress', steps: [
        { content: 'step 1', status: 'completed' },
        { content: 'step 2', status: 'pending' },
      ] },
      { title: 'phase B', status: 'pending' },
    ]);
    const md = formatPlanAsMarkdown(plan);
    expect(md).toBe(
      '1. [in_progress] phase A\n' +
      '  - [completed] step 1\n' +
      '  - [pending] step 2\n' +
      '2. [pending] phase B'
    );
  });
});

describe('MasterTaskManager.subscribeToPlanning', () => {
  let manager: MasterTaskManager;

  beforeEach(() => {
    manager = new MasterTaskManager();
    // 内存只：persist:false 避免要 DB schema
    manager.register(
      { title: 't', workspaceUri: 'file:///tmp/ws' },
      { id: 'mt-1', persist: false },
    );
  });

  afterEach(() => {
    // 清理避免跨 case 污染（subscribeToPlanning 把 listener 挂在 module-level emitter）
    manager.unregister('mt-1');
    planningStateEmitter.removeAllListeners('plan_updated');
  });

  it('1) emit plan_updated after subscribe triggers appendPlanProgress', () => {
    const spy = vi.spyOn(manager, 'appendPlanProgress').mockImplementation(() => {});
    manager.subscribeToPlanning('mt-1');

    const plan = makePlan([{ title: 'A', steps: [{ content: 's1' }] }]);
    planningStateEmitter.emit('plan_updated', makeState(plan));

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith('mt-1', expect.any(String));
  });

  it('2) first emit: chunk is the full markdown (previousPlanString starts empty)', () => {
    const spy = vi.spyOn(manager, 'appendPlanProgress').mockImplementation(() => {});
    manager.subscribeToPlanning('mt-1');

    const plan = makePlan([{ title: 'phase A', steps: [{ content: 'step 1' }] }]);
    planningStateEmitter.emit('plan_updated', makeState(plan));

    const expected = '1. [pending] phase A\n  - [pending] step 1';
    expect(spy).toHaveBeenCalledWith('mt-1', expected);
  });

  it('3) append-only growth: second emit yields only the newly-appended tail', () => {
    const spy = vi.spyOn(manager, 'appendPlanProgress').mockImplementation(() => {});
    manager.subscribeToPlanning('mt-1');

    // 首次：1 phase
    const plan1 = makePlan([{ title: 'phase A' }]);
    planningStateEmitter.emit('plan_updated', makeState(plan1));
    const first = spy.mock.calls[0][1];
    expect(first).toBe('1. [pending] phase A');

    // 二次：plan1 的尾部追加 1 个 step（保证 startsWith 成立）
    const plan2 = makePlan([{ title: 'phase A', steps: [{ content: 's1' }] }]);
    planningStateEmitter.emit('plan_updated', makeState(plan2));
    expect(spy).toHaveBeenCalledTimes(2);
    const second = spy.mock.calls[1][1];
    // append 的尾部应该是 \n + 新的 step 行
    expect(second).toBe('\n  - [pending] s1');
  });

  it('4) non-append-only (plan revised) emits marker chunk', () => {
    const spy = vi.spyOn(manager, 'appendPlanProgress').mockImplementation(() => {});
    manager.subscribeToPlanning('mt-1');

    // 首次：plan A
    planningStateEmitter.emit('plan_updated', makeState(makePlan([{ title: 'phase A' }])));
    expect(spy).toHaveBeenCalledTimes(1);

    // 二次：plan 改写为完全不同的 phase（不再以前序为前缀）
    planningStateEmitter.emit('plan_updated', makeState(makePlan([{ title: 'phase Z', status: 'completed' }])));
    expect(spy).toHaveBeenCalledTimes(2);
    const second = spy.mock.calls[1][1];
    expect(second.startsWith('\n---\n[plan revised]\n')).toBe(true);
    expect(second).toContain('1. [completed] phase Z');
  });

  it('5) duplicate plan (next === previous): appendPlanProgress NOT called', () => {
    const spy = vi.spyOn(manager, 'appendPlanProgress').mockImplementation(() => {});
    manager.subscribeToPlanning('mt-1');

    const plan = makePlan([{ title: 'phase A' }]);
    planningStateEmitter.emit('plan_updated', makeState(plan));
    expect(spy).toHaveBeenCalledTimes(1);

    // 再 emit 同一份 plan（相同序列化结果）
    planningStateEmitter.emit('plan_updated', makeState(plan));
    planningStateEmitter.emit('plan_updated', makeState(makePlan([{ title: 'phase A' }])));
    expect(spy).toHaveBeenCalledTimes(1); // 没有新增调用
  });

  it('6) after unsubscribe: emit stops triggering appendPlanProgress', () => {
    const spy = vi.spyOn(manager, 'appendPlanProgress').mockImplementation(() => {});
    const sub = manager.subscribeToPlanning('mt-1');

    planningStateEmitter.emit('plan_updated', makeState(makePlan([{ title: 'A' }])));
    expect(spy).toHaveBeenCalledTimes(1);

    sub.unsubscribe();

    planningStateEmitter.emit('plan_updated', makeState(makePlan([{ title: 'A', steps: [{ content: 's' }] }])));
    expect(spy).toHaveBeenCalledTimes(1); // 没新增
  });

  it('7) idempotent subscribe: re-subscribing same masterTaskId does not attach another listener', () => {
    const spy = vi.spyOn(manager, 'appendPlanProgress').mockImplementation(() => {});
    const sub1 = manager.subscribeToPlanning('mt-1');
    const sub2 = manager.subscribeToPlanning('mt-1');

    // emitter 上挂的 listener 数仍是 1
    expect(planningStateEmitter.listenerCount('plan_updated')).toBe(1);

    planningStateEmitter.emit('plan_updated', makeState(makePlan([{ title: 'A' }])));
    // 只触发一次 appendPlanProgress（如果挂了两次，spy 会被调两次）
    expect(spy).toHaveBeenCalledTimes(1);

    // 两个 unsubscribe handle 都可调，但都指向同一个 sub
    sub1.unsubscribe();
    expect(planningStateEmitter.listenerCount('plan_updated')).toBe(0);
    sub2.unsubscribe(); // no-op，不抛
    expect(planningStateEmitter.listenerCount('plan_updated')).toBe(0);
  });

  it('8) unregister(masterTaskId) auto-unsubscribes planning', () => {
    const spy = vi.spyOn(manager, 'appendPlanProgress').mockImplementation(() => {});
    manager.subscribeToPlanning('mt-1');
    expect(planningStateEmitter.listenerCount('plan_updated')).toBe(1);

    manager.unregister('mt-1');
    expect(planningStateEmitter.listenerCount('plan_updated')).toBe(0);

    // 再 emit 也不会触发（master 已经从内存移除 — 即便 listener 漏挂也会因 requireById 失败）
    planningStateEmitter.emit('plan_updated', makeState(makePlan([{ title: 'A' }])));
    expect(spy).not.toHaveBeenCalled();
  });
});
