// ============================================================================
// SwarmLaunchApprovalGate Tests
// 覆盖 headless fast-path、approve/reject 正向路径、
// timeout 的 writeAgentCount 分档 fail-closed（有写→reject / 全只读→approve）、
// createRequest 衍生字段、query helpers
// ============================================================================

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../../../src/main/services/infra/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// ---------------------------------------------------------------------------
// Mock platform.BrowserWindow — 控制是否有 renderer 附加
// ---------------------------------------------------------------------------

const windowState = vi.hoisted(() => ({
  count: 1, // 默认有 renderer
}));

vi.mock('../../../src/main/platform', () => ({
  BrowserWindow: {
    getAllWindows: () => new Array(windowState.count).fill({}),
  },
}));

// ---------------------------------------------------------------------------
// Mock EventBus — 收集事件用于断言
// ---------------------------------------------------------------------------

const busState = vi.hoisted(() => ({
  publishMock: vi.fn(),
}));

vi.mock('../../../src/main/protocol/events/bus', () => ({
  getEventBus: () => ({ publish: busState.publishMock }),
}));

import { SwarmLaunchApprovalGate } from '../../../src/main/agent/swarmLaunchApproval';
import type { SwarmLaunchTaskPreview } from '../../../src/shared/contract/swarm';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTask(
  overrides: Partial<SwarmLaunchTaskPreview> = {}
): SwarmLaunchTaskPreview {
  return {
    id: overrides.id ?? 'task-1',
    role: overrides.role ?? 'coder',
    task: overrides.task ?? 'implement feature',
    tools: overrides.tools ?? ['Read'],
    writeAccess: overrides.writeAccess ?? false,
    dependsOn: overrides.dependsOn ?? [],
    ...overrides,
  };
}

function makeGate(timeoutMs = 1_000): SwarmLaunchApprovalGate {
  return new SwarmLaunchApprovalGate({ approvalTimeoutMs: timeoutMs });
}

describe('SwarmLaunchApprovalGate', () => {
  let gate: SwarmLaunchApprovalGate;

  beforeEach(() => {
    windowState.count = 1;
    busState.publishMock.mockReset();
    gate = makeGate(1_000);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ==========================================================================
  // Headless fast-path
  // ==========================================================================

  describe('headless fast-path', () => {
    it('没有 renderer 时立即 auto-approve 且不入队列', async () => {
      windowState.count = 0;

      const result = await gate.requestApproval({
        tasks: [makeTask({ id: 't1', writeAccess: true })],
      });

      expect(result.approved).toBe(true);
      expect(result.autoApproved).toBe(true);
      expect(result.feedback).toMatch(/headless/);
      // 未发布 launch:requested 事件
      expect(busState.publishMock).not.toHaveBeenCalled();
      expect(gate.getPendingRequests()).toHaveLength(0);
    });
  });

  // ==========================================================================
  // createRequest 衍生字段
  // ==========================================================================

  describe('createRequest 衍生字段', () => {
    it('agentCount/dependencyCount/writeAgentCount 从 tasks 正确推导', async () => {
      vi.useFakeTimers();

      const pending = gate.requestApproval({
        tasks: [
          makeTask({ id: 't1', writeAccess: true }),
          makeTask({ id: 't2', writeAccess: false, dependsOn: ['t1'] }),
          makeTask({ id: 't3', writeAccess: true, dependsOn: ['t1', 't2'] }),
        ],
        summary: 'custom summary',
      });

      await vi.advanceTimersByTimeAsync(0);

      const reqs = gate.getPendingRequests();
      expect(reqs).toHaveLength(1);
      const req = reqs[0];
      expect(req.agentCount).toBe(3);
      expect(req.dependencyCount).toBe(3);
      expect(req.writeAgentCount).toBe(2);
      expect(req.summary).toBe('custom summary');

      // 收尾：approve 让 promise 结算
      gate.approve(req.id);
      await vi.advanceTimersByTimeAsync(500);
      await pending;
    });

    it('缺省 summary 时按 agentCount 生成默认描述', async () => {
      vi.useFakeTimers();

      const pending = gate.requestApproval({
        tasks: [makeTask({ id: 't1' }), makeTask({ id: 't2' })],
      });
      await vi.advanceTimersByTimeAsync(0);

      const req = gate.getPendingRequests()[0];
      expect(req.summary).toContain('2');
      expect(req.summary).toMatch(/agent/i);

      gate.approve(req.id);
      await vi.advanceTimersByTimeAsync(500);
      await pending;
    });
  });

  // ==========================================================================
  // approve / reject 正向路径
  // ==========================================================================

  describe('审批流', () => {
    it('外部 approve 把 request 转为 approved 并结算 promise', async () => {
      vi.useFakeTimers();

      const pending = gate.requestApproval({ tasks: [makeTask({ id: 't1' })] });
      await vi.advanceTimersByTimeAsync(0);

      const reqId = gate.getPendingRequests()[0].id;
      expect(gate.approve(reqId, 'go')).toBe(true);

      await vi.advanceTimersByTimeAsync(500);

      const result = await pending;
      expect(result.approved).toBe(true);
      expect(result.feedback).toBe('go');
      expect(result.autoApproved).toBe(false);
      // 发布 approved 事件
      expect(
        busState.publishMock.mock.calls.some(
          (c) => c[1] === 'launch:approved'
        )
      ).toBe(true);
    });

    it('外部 reject 把 request 转为 rejected 并结算 promise', async () => {
      vi.useFakeTimers();

      const pending = gate.requestApproval({
        tasks: [makeTask({ id: 't1', writeAccess: true })],
      });
      await vi.advanceTimersByTimeAsync(0);

      const reqId = gate.getPendingRequests()[0].id;
      expect(gate.reject(reqId, 'unsafe')).toBe(true);

      await vi.advanceTimersByTimeAsync(500);

      const result = await pending;
      expect(result.approved).toBe(false);
      expect(result.feedback).toBe('unsafe');
      expect(result.autoApproved).toBe(false);
    });

    it('重复 approve / 未知 id 返回 false', async () => {
      vi.useFakeTimers();

      const pending = gate.requestApproval({ tasks: [makeTask({ id: 't1' })] });
      await vi.advanceTimersByTimeAsync(0);

      const reqId = gate.getPendingRequests()[0].id;
      gate.approve(reqId);

      expect(gate.approve(reqId)).toBe(false);
      expect(gate.reject(reqId, 'flip')).toBe(false);
      expect(gate.approve('launch_nonexistent')).toBe(false);
      expect(gate.reject('launch_nonexistent', 'x')).toBe(false);

      await vi.advanceTimersByTimeAsync(500);
      await pending;
    });

    it('提交后发布 launch:requested 事件', async () => {
      vi.useFakeTimers();

      const pending = gate.requestApproval({ tasks: [makeTask({ id: 't1' })] });
      await vi.advanceTimersByTimeAsync(0);

      const call = busState.publishMock.mock.calls.find(
        (c) => c[1] === 'launch:requested'
      );
      expect(call).toBeDefined();
      expect(call?.[0]).toBe('swarm');

      // 收尾
      gate.approve(gate.getPendingRequests()[0].id);
      await vi.advanceTimersByTimeAsync(500);
      await pending;
    });
  });

  // ==========================================================================
  // Timeout fail-closed 按 writeAgentCount 分档
  // ==========================================================================

  describe('超时 fail-closed 分档', () => {
    it('有写 agent 时超时 auto-reject（避免无人值守的并发写冲突）', async () => {
      vi.useFakeTimers();
      gate = makeGate(500);

      const pending = gate.requestApproval({
        tasks: [
          makeTask({ id: 't1', writeAccess: true }),
          makeTask({ id: 't2', writeAccess: false }),
        ],
      });

      await vi.advanceTimersByTimeAsync(1_200);

      const result = await pending;
      expect(result.approved).toBe(false);
      expect(result.autoApproved).toBe(true);
      expect(result.feedback).toMatch(/Auto-rejected after timeout/);
      expect(result.feedback).toMatch(/writeAgentCount=1/);
    });

    it('全只读任务超时 auto-approve（保活低风险探查）', async () => {
      vi.useFakeTimers();
      gate = makeGate(500);

      const pending = gate.requestApproval({
        tasks: [
          makeTask({ id: 't1', writeAccess: false }),
          makeTask({ id: 't2', writeAccess: false }),
        ],
      });

      await vi.advanceTimersByTimeAsync(1_200);

      const result = await pending;
      expect(result.approved).toBe(true);
      expect(result.autoApproved).toBe(true);
      expect(result.feedback).toMatch(/Auto-approved after timeout/);
      expect(result.feedback).toMatch(/read-only/);
    });

    it('超时后 request 状态持久化（可从 getRequest 查）', async () => {
      vi.useFakeTimers();
      gate = makeGate(500);

      const pending = gate.requestApproval({
        tasks: [makeTask({ id: 't1', writeAccess: true })],
      });
      await vi.advanceTimersByTimeAsync(0);
      const reqId = gate.getPendingRequests()[0].id;

      await vi.advanceTimersByTimeAsync(1_200);
      await pending;

      const snap = gate.getRequest(reqId);
      expect(snap?.status).toBe('rejected');
      expect(snap?.resolvedAt).toBeTypeOf('number');
    });
  });

  // ==========================================================================
  // Query helpers
  // ==========================================================================

  describe('query', () => {
    it('getPendingRequests 只返回 pending 状态', async () => {
      vi.useFakeTimers();

      const pending = gate.requestApproval({ tasks: [makeTask({ id: 't1' })] });
      await vi.advanceTimersByTimeAsync(0);

      expect(gate.getPendingRequests()).toHaveLength(1);

      gate.approve(gate.getPendingRequests()[0].id);
      expect(gate.getPendingRequests()).toHaveLength(0);

      await vi.advanceTimersByTimeAsync(500);
      await pending;
    });

    it('getRequest 返回 tasks 数组的深拷贝', async () => {
      vi.useFakeTimers();

      const pending = gate.requestApproval({
        tasks: [makeTask({ id: 't1' })],
      });
      await vi.advanceTimersByTimeAsync(0);

      const reqId = gate.getPendingRequests()[0].id;
      const snap1 = gate.getRequest(reqId)!;
      const snap2 = gate.getRequest(reqId)!;
      expect(snap1).not.toBe(snap2);
      expect(snap1.tasks).not.toBe(snap2.tasks);
      expect(snap1.tasks[0]).not.toBe(snap2.tasks[0]);

      gate.approve(reqId);
      await vi.advanceTimersByTimeAsync(500);
      await pending;
    });

    it('getRequest 对未知 id 返回 undefined', () => {
      expect(gate.getRequest('launch_missing')).toBeUndefined();
    });
  });
});
