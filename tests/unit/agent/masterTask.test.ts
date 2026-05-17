// ============================================================================
// MasterTask Tests
// 状态机（valid + invalid transitions）、副作用、内部字段
// ============================================================================

import { describe, it, expect, vi } from 'vitest';

import {
  MasterTask,
  InvalidMasterTaskTransitionError,
  type MasterTaskMetadata,
} from '../../../src/main/agent/masterTask';
import type { MasterTaskStatus } from '../../../src/shared/contract/task';

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

function makeMetadata(overrides?: Partial<MasterTaskMetadata>): MasterTaskMetadata {
  return {
    title: 'demo task',
    workspaceUri: 'file:///tmp/workspace',
    ...overrides,
  };
}

function makeTask(id = 'mt-1', overrides?: Partial<MasterTaskMetadata>): MasterTask {
  return new MasterTask(id, makeMetadata(overrides));
}

/** 把 MasterTask 直接驱动到目标状态（绕过状态机一致性，只用合法路径） */
function driveTo(task: MasterTask, target: MasterTaskStatus): void {
  switch (target) {
    case 'created':
      return;
    case 'pending':
      task.advance();
      return;
    case 'queued':
      task.advance();
      task.enqueue();
      return;
    case 'waiting':
      task.advance();
      task.waitForDependency();
      return;
    case 'running':
      task.advance();
      task.start();
      return;
    case 'paused':
      task.advance();
      task.start();
      task.pause();
      return;
    case 'review':
      task.advance();
      task.start();
      task.requestReview();
      return;
    case 'completed':
      task.advance();
      task.start();
      task.complete();
      return;
    case 'done':
      task.advance();
      task.start();
      task.requestReview();
      task.approveReview();
      return;
    case 'cancelled':
      task.advance();
      task.cancel();
      return;
    case 'failed':
      task.advance();
      task.start();
      task.fail('boom');
      return;
    case 'error':
      task.advance();
      task.errorOut('boom');
      return;
  }
}

// --------------------------------------------------------------------------
// Constructor & 初始化
// --------------------------------------------------------------------------

describe('MasterTask constructor & initialization', () => {
  it('初始 status === created', () => {
    const task = makeTask();
    expect(task.status).toBe('created');
  });

  it('title / workspaceUri 写入正确', () => {
    const task = new MasterTask('mt-x', makeMetadata({
      title: 'Hello',
      workspaceUri: 'file:///home/user/proj',
    }));
    expect(task.title).toBe('Hello');
    expect(task.workspaceUri).toBe('file:///home/user/proj');
  });

  it('ownerUserId 默认 local', () => {
    const task = makeTask();
    expect(task.ownerUserId).toBe('local');
  });

  it('ownerUserId 可被覆盖', () => {
    const task = new MasterTask('mt-x', makeMetadata({ ownerUserId: 'alice' }));
    expect(task.ownerUserId).toBe('alice');
  });

  it('可选字段 sandboxId / parentTaskId 不传时 undefined', () => {
    const task = makeTask();
    expect(task.sandboxId).toBeUndefined();
    expect(task.parentTaskId).toBeUndefined();
  });

  it('可选字段 sandboxId / parentTaskId 传入时正确写入', () => {
    const task = new MasterTask('mt-x', makeMetadata({
      sandboxId: 'sbx-1',
      parentTaskId: 'mt-parent',
    }));
    expect(task.sandboxId).toBe('sbx-1');
    expect(task.parentTaskId).toBe('mt-parent');
  });

  it('blocks / blockedBy 初始化为 Set（空）', () => {
    const task = makeTask();
    expect(task.blocks).toBeInstanceOf(Set);
    expect(task.blockedBy).toBeInstanceOf(Set);
    expect(task.blocks.size).toBe(0);
    expect(task.blockedBy.size).toBe(0);
  });

  it('blocks / blockedBy 可被 metadata 初始化', () => {
    const task = new MasterTask('mt-x', makeMetadata({
      blocks: ['a', 'b'],
      blockedBy: ['c'],
    }));
    expect(task.blocks.has('a')).toBe(true);
    expect(task.blocks.has('b')).toBe(true);
    expect(task.blockedBy.has('c')).toBe(true);
  });

  it('planProgress 初始空字符串；childAgentTaskIds / attachedSessionIds 初始空 Set', () => {
    const task = makeTask();
    expect(task.planProgress).toBe('');
    expect(task.childAgentTaskIds).toBeInstanceOf(Set);
    expect(task.childAgentTaskIds.size).toBe(0);
    expect(task.attachedSessionIds).toBeInstanceOf(Set);
    expect(task.attachedSessionIds.size).toBe(0);
  });
});

// --------------------------------------------------------------------------
// Valid transitions
// --------------------------------------------------------------------------

describe('MasterTask state machine — valid transitions', () => {
  it('created → advance → pending', () => {
    const task = makeTask();
    task.advance();
    expect(task.status).toBe('pending');
  });

  it('pending → enqueue → queued', () => {
    const task = makeTask();
    task.advance();
    task.enqueue();
    expect(task.status).toBe('queued');
  });

  it('pending → waitForDependency → waiting', () => {
    const task = makeTask();
    task.advance();
    task.waitForDependency();
    expect(task.status).toBe('waiting');
  });

  it('queued → waitForDependency → waiting', () => {
    const task = makeTask();
    task.advance();
    task.enqueue();
    task.waitForDependency();
    expect(task.status).toBe('waiting');
  });

  it('pending → start → running', () => {
    const task = makeTask();
    task.advance();
    task.start();
    expect(task.status).toBe('running');
    expect(task.abortController).not.toBeNull();
  });

  it('queued → start → running', () => {
    const task = makeTask();
    task.advance();
    task.enqueue();
    task.start();
    expect(task.status).toBe('running');
  });

  it('waiting → start → running', () => {
    const task = makeTask();
    driveTo(task, 'waiting');
    task.start();
    expect(task.status).toBe('running');
  });

  it('paused → start → running', () => {
    const task = makeTask();
    driveTo(task, 'paused');
    task.start();
    expect(task.status).toBe('running');
    expect(task.abortController).not.toBeNull();
  });

  it('review → start → running（直接调用 start 也合法）', () => {
    const task = makeTask();
    driveTo(task, 'review');
    task.start();
    expect(task.status).toBe('running');
  });

  it('running → pause → paused', () => {
    const task = makeTask();
    driveTo(task, 'running');
    task.pause();
    expect(task.status).toBe('paused');
    expect(task.abortController).toBeNull();
  });

  it('running → requestReview → review', () => {
    const task = makeTask();
    driveTo(task, 'running');
    task.requestReview();
    expect(task.status).toBe('review');
  });

  it('review → approveReview → done', () => {
    const task = makeTask();
    driveTo(task, 'review');
    task.approveReview();
    expect(task.status).toBe('done');
  });

  it('review → rejectReview → running', () => {
    const task = makeTask();
    driveTo(task, 'review');
    task.rejectReview();
    expect(task.status).toBe('running');
    expect(task.abortController).not.toBeNull();
  });

  it('running → complete → completed', () => {
    const task = makeTask();
    driveTo(task, 'running');
    task.complete();
    expect(task.status).toBe('completed');
    expect(task.abortController).toBeNull();
  });

  it('running → fail → failed', () => {
    const task = makeTask();
    driveTo(task, 'running');
    task.fail('boom');
    expect(task.status).toBe('failed');
    expect(task.error).toBe('boom');
  });

  it('pending → errorOut → error', () => {
    const task = makeTask();
    task.advance();
    task.errorOut('boom');
    expect(task.status).toBe('error');
    expect(task.error).toBe('boom');
  });

  it('running → cancel → cancelled', () => {
    const task = makeTask();
    driveTo(task, 'running');
    const ctrl = task.abortController!;
    expect(ctrl.signal.aborted).toBe(false);
    task.cancel();
    expect(task.status).toBe('cancelled');
    expect(ctrl.signal.aborted).toBe(true);
    expect(task.abortController).toBeNull();
  });
});

// --------------------------------------------------------------------------
// Invalid transitions
// --------------------------------------------------------------------------

describe('MasterTask state machine — invalid transitions', () => {
  it('created → complete throws（跳过整个流程）', () => {
    const task = makeTask();
    expect(() => task.complete()).toThrowError(InvalidMasterTaskTransitionError);
  });

  it('completed → start throws（从终态回退）', () => {
    const task = makeTask();
    driveTo(task, 'completed');
    expect(() => task.start()).toThrowError(InvalidMasterTaskTransitionError);
  });

  it('cancelled → start throws', () => {
    const task = makeTask();
    driveTo(task, 'cancelled');
    expect(() => task.start()).toThrowError(InvalidMasterTaskTransitionError);
  });

  it('created → pause throws（跳过 advance）', () => {
    const task = makeTask();
    expect(() => task.pause()).toThrowError(InvalidMasterTaskTransitionError);
  });

  it('failed → errorOut throws（从终态再 error）', () => {
    const task = makeTask();
    driveTo(task, 'failed');
    expect(() => task.errorOut('again')).toThrowError(InvalidMasterTaskTransitionError);
  });

  it('done → cancel throws（从终态再 cancel）', () => {
    const task = makeTask();
    driveTo(task, 'done');
    expect(() => task.cancel()).toThrowError(InvalidMasterTaskTransitionError);
  });

  it('error message 含 from → to 状态字面量 + 自定义错误名', () => {
    const task = makeTask();
    let err: InvalidMasterTaskTransitionError | undefined;
    try {
      task.complete();
    } catch (e) {
      err = e as InvalidMasterTaskTransitionError;
    }
    expect(err).toBeDefined();
    expect(err!.message).toContain('created');
    expect(err!.message).toContain('completed');
    expect(err!.name).toBe('InvalidMasterTaskTransitionError');
  });
});

// --------------------------------------------------------------------------
// Side effects
// --------------------------------------------------------------------------

describe('MasterTask side effects', () => {
  it('advance 触发 onHook(TaskCreated)', () => {
    const task = makeTask('mt-hook');
    const hook = vi.fn();
    task.onHook = hook;
    task.advance();
    expect(hook).toHaveBeenCalledTimes(1);
    expect(hook).toHaveBeenCalledWith('TaskCreated', {
      taskId: 'mt-hook',
      agentType: 'master',
    });
  });

  it('complete 触发 onHook(TaskCompleted, success=true)', () => {
    const task = makeTask('mt-c');
    const hook = vi.fn();
    task.onHook = hook;
    driveTo(task, 'running');
    hook.mockClear(); // 清掉 advance 触发的 TaskCreated
    task.complete();
    expect(hook).toHaveBeenCalledTimes(1);
    expect(hook).toHaveBeenCalledWith('TaskCompleted', {
      taskId: 'mt-c',
      agentType: 'master',
      success: true,
    });
  });

  it('fail 触发 onHook(TaskCompleted, success=false) 且 error 字段写入', () => {
    const task = makeTask('mt-f');
    const hook = vi.fn();
    task.onHook = hook;
    driveTo(task, 'running');
    hook.mockClear();
    task.fail('disk full');
    expect(task.error).toBe('disk full');
    expect(hook).toHaveBeenCalledWith('TaskCompleted', {
      taskId: 'mt-f',
      agentType: 'master',
      success: false,
    });
  });

  it('cancel 触发 onHook(TaskCompleted, success=false)', () => {
    const task = makeTask('mt-cancel');
    const hook = vi.fn();
    task.onHook = hook;
    driveTo(task, 'running');
    hook.mockClear();
    task.cancel();
    expect(hook).toHaveBeenCalledWith('TaskCompleted', {
      taskId: 'mt-cancel',
      agentType: 'master',
      success: false,
    });
  });

  it('errorOut 触发 onHook(TaskCompleted, success=false) 且 error 字段写入', () => {
    const task = makeTask('mt-err');
    const hook = vi.fn();
    task.onHook = hook;
    task.advance();
    hook.mockClear();
    task.errorOut('crash');
    expect(task.error).toBe('crash');
    expect(hook).toHaveBeenCalledWith('TaskCompleted', {
      taskId: 'mt-err',
      agentType: 'master',
      success: false,
    });
  });

  it('start 创建 abortController；pause / cancel / fail 后 abortController === null', () => {
    const task = makeTask();
    task.advance();
    task.start();
    expect(task.abortController).not.toBeNull();
    task.pause();
    expect(task.abortController).toBeNull();

    task.start();
    expect(task.abortController).not.toBeNull();
    task.fail('x');
    expect(task.abortController).toBeNull();

    const t2 = makeTask('mt-2');
    t2.advance();
    t2.start();
    t2.cancel();
    expect(t2.abortController).toBeNull();
  });

  it('pause 会 abort 旧的 controller', () => {
    const task = makeTask();
    task.advance();
    task.start();
    const ctrl = task.abortController!;
    task.pause();
    expect(ctrl.signal.aborted).toBe(true);
  });

  it('rejectReview 重建 abortController', () => {
    const task = makeTask();
    driveTo(task, 'review');
    expect(task.abortController).not.toBeNull(); // start() 之后还在
    task.rejectReview();
    expect(task.abortController).not.toBeNull();
  });
});

// --------------------------------------------------------------------------
// 其他字段方法
// --------------------------------------------------------------------------

describe('MasterTask field methods', () => {
  it('appendPlanProgress 累加字符串', () => {
    const task = makeTask();
    task.appendPlanProgress('step 1\n');
    task.appendPlanProgress('step 2\n');
    expect(task.planProgress).toBe('step 1\nstep 2\n');
  });

  it('attachAgentTask 加入 Set 且去重', () => {
    const task = makeTask();
    task.attachAgentTask('agent-1');
    task.attachAgentTask('agent-2');
    task.attachAgentTask('agent-1');
    expect(task.childAgentTaskIds.size).toBe(2);
    expect(task.childAgentTaskIds.has('agent-1')).toBe(true);
    expect(task.childAgentTaskIds.has('agent-2')).toBe(true);
  });

  it('attachSession 加入 Set 且去重', () => {
    const task = makeTask();
    task.attachSession('sess-1');
    task.attachSession('sess-1');
    task.attachSession('sess-2');
    expect(task.attachedSessionIds.size).toBe(2);
  });

  it('isReady() 在 blockedBy 空时 true', () => {
    const task = makeTask();
    expect(task.isReady()).toBe(true);
  });

  it('isReady() 在 blockedBy 非空时 false；移除依赖后变 true', () => {
    const task = makeTask();
    task.addDependency('blocker-1');
    expect(task.isReady()).toBe(false);
    task.removeDependency('blocker-1');
    expect(task.isReady()).toBe(true);
  });

  it('addDependency / removeDependency 工作正常（继承自基类）', () => {
    const task = makeTask();
    task.addDependency('a');
    task.addDependency('b');
    expect(task.blockedBy.has('a')).toBe(true);
    expect(task.blockedBy.size).toBe(2);
    task.removeDependency('a');
    expect(task.blockedBy.has('a')).toBe(false);
    expect(task.blockedBy.size).toBe(1);
  });
});
