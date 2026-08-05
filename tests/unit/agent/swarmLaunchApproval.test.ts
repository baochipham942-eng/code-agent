// ============================================================================
// SwarmLaunchApprovalGate Tests（施工单二 B）
// headless / 全只读 / 写成员×acceptEdits / 写成员×bypassPermissions /
// 写成员×default 等待 / approve / reject / cancelSession
// 变异：去掉档位判断时 acceptEdits 用例必须红
// ============================================================================

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../../../src/host/services/infra/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

const windowState = vi.hoisted(() => ({
  count: 1,
}));

vi.mock('../../../src/host/platform', () => ({
  AppWindow: {
    getAllWindows: () => new Array(windowState.count).fill({}),
  },
}));

const busState = vi.hoisted(() => ({
  publishMock: vi.fn(),
}));

vi.mock('../../../src/host/services/eventing/bus', () => ({
  getEventBus: () => ({ publish: busState.publishMock }),
}));

const permissionState = vi.hoisted(() => ({
  mode: 'default' as string,
}));

vi.mock('../../../src/host/permissions/modes', () => ({
  getPermissionModeManager: () => ({
    getModeForSession: () => permissionState.mode,
  }),
}));

import { SwarmLaunchApprovalGate } from '../../../src/host/agent/swarmLaunchApproval';
import type { SwarmLaunchTaskPreview, SwarmRunScope } from '../../../src/shared/contract/swarm';

const TEST_SCOPE: SwarmRunScope = {
  sessionId: 'session-launch-test',
  runId: 'run-launch-test',
  treeId: 'tree-launch-test',
};

function makeTask(overrides: Partial<SwarmLaunchTaskPreview> = {}): SwarmLaunchTaskPreview {
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

function makeGate(): SwarmLaunchApprovalGate {
  return new SwarmLaunchApprovalGate();
}

describe('SwarmLaunchApprovalGate', () => {
  let gate: SwarmLaunchApprovalGate;

  beforeEach(() => {
    windowState.count = 1;
    permissionState.mode = 'default';
    busState.publishMock.mockReset();
    gate = makeGate();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('headless fast-path', () => {
    it('没有 renderer 时立即 auto-approve 且不入队列', async () => {
      windowState.count = 0;

      const result = await gate.requestApproval({
        scope: TEST_SCOPE,
        tasks: [makeTask({ id: 't1', writeAccess: true })],
      });

      expect(result.approved).toBe(true);
      expect(result.autoApproved).toBe(true);
      expect(result.feedback).toMatch(/headless/);
      expect(busState.publishMock).not.toHaveBeenCalled();
      expect(gate.getPendingRequests()).toHaveLength(0);
    });
  });

  describe('read-only auto-approve', () => {
    it.each(['default', 'readOnly', 'acceptEdits', 'bypassPermissions'] as const)(
      'writeAgentCount===0 在档 %s 下立即自动批',
      async (mode) => {
        permissionState.mode = mode;
        const result = await gate.requestApproval({
          scope: TEST_SCOPE,
          tasks: [
            makeTask({ id: 't1', writeAccess: false }),
            makeTask({ id: 't2', writeAccess: false }),
          ],
        });
        expect(result.approved).toBe(true);
        expect(result.autoApproved).toBe(true);
        expect(result.feedback).toMatch(/read-only/);
        expect(gate.getPendingRequests()).toHaveLength(0);
        expect(busState.publishMock).not.toHaveBeenCalled();
      },
    );
  });

  describe('session permission mode auto-approve', () => {
    it('写成员 × acceptEdits 立即自动批（变异点：去掉档位判断本用例必红）', async () => {
      permissionState.mode = 'acceptEdits';
      const result = await gate.requestApproval({
        scope: TEST_SCOPE,
        tasks: [makeTask({ id: 't1', writeAccess: true })],
      });
      expect(result.approved).toBe(true);
      expect(result.autoApproved).toBe(true);
      expect(result.feedback).toMatch(/acceptEdits/);
      expect(gate.getPendingRequests()).toHaveLength(0);
    });

    it('写成员 × bypassPermissions 立即自动批', async () => {
      permissionState.mode = 'bypassPermissions';
      const result = await gate.requestApproval({
        scope: TEST_SCOPE,
        tasks: [makeTask({ id: 't1', writeAccess: true })],
      });
      expect(result.approved).toBe(true);
      expect(result.autoApproved).toBe(true);
      expect(result.feedback).toMatch(/bypassPermissions/);
    });
  });

  describe('default mode wait (no timeout)', () => {
    it('写成员 × default 进入等待且不超时自动结算', async () => {
      permissionState.mode = 'default';
      vi.useFakeTimers();

      const pending = gate.requestApproval({
        scope: TEST_SCOPE,
        tasks: [makeTask({ id: 't1', writeAccess: true })],
      });

      await vi.advanceTimersByTimeAsync(0);
      expect(gate.getPendingRequests()).toHaveLength(1);
      expect(busState.publishMock.mock.calls.some((c) => c[1] === 'launch:requested')).toBe(true);

      // 原 120s 超时路径已退役：推进远超旧超时也不自动结算
      await vi.advanceTimersByTimeAsync(300_000);
      expect(gate.getPendingRequests()).toHaveLength(1);
      expect(gate.getPendingResolverCount()).toBe(1);

      const reqId = gate.getPendingRequests()[0].id;
      gate.approve(reqId, 'go');
      const result = await pending;
      expect(result.approved).toBe(true);
      expect(result.autoApproved).toBe(false);
      expect(result.feedback).toBe('go');
    });

    it('等待中 reject 结算 promise', async () => {
      permissionState.mode = 'default';
      const pending = gate.requestApproval({
        scope: TEST_SCOPE,
        tasks: [makeTask({ id: 't1', writeAccess: true })],
      });
      await Promise.resolve();
      const reqId = gate.getPendingRequests()[0].id;
      expect(gate.reject(reqId, 'unsafe')).toBe(true);
      const result = await pending;
      expect(result.approved).toBe(false);
      expect(result.feedback).toBe('unsafe');
      expect(result.autoApproved).toBe(false);
    });

    it('等待中 cancelSession 排干 pending', async () => {
      permissionState.mode = 'default';
      const pending = gate.requestApproval({
        scope: TEST_SCOPE,
        tasks: [makeTask({ id: 't1', writeAccess: true })],
      });
      await Promise.resolve();
      expect(gate.cancelSession(TEST_SCOPE.sessionId, 'session closed')).toBe(1);
      const result = await pending;
      expect(result.approved).toBe(false);
      expect(result.autoApproved).toBe(true);
      expect(result.feedback).toMatch(/session closed/);
      expect(gate.getPendingResolverCount()).toBe(0);
    });
  });

  describe('createRequest 衍生字段', () => {
    it('agentCount/dependencyCount/writeAgentCount 从 tasks 正确推导', async () => {
      permissionState.mode = 'default';
      const pending = gate.requestApproval({
        scope: TEST_SCOPE,
        tasks: [
          makeTask({ id: 't1', writeAccess: true }),
          makeTask({ id: 't2', writeAccess: false, dependsOn: ['t1'] }),
          makeTask({ id: 't3', writeAccess: true, dependsOn: ['t1', 't2'] }),
        ],
        summary: 'custom summary',
      });
      await Promise.resolve();

      const reqs = gate.getPendingRequests();
      expect(reqs).toHaveLength(1);
      expect(reqs[0].agentCount).toBe(3);
      expect(reqs[0].dependencyCount).toBe(3);
      expect(reqs[0].writeAgentCount).toBe(2);
      expect(reqs[0].summary).toBe('custom summary');

      gate.approve(reqs[0].id);
      await pending;
    });
  });

  describe('query', () => {
    it('getPendingRequests 只返回 pending 状态', async () => {
      permissionState.mode = 'default';
      const pending = gate.requestApproval({
        scope: TEST_SCOPE,
        tasks: [makeTask({ id: 't1', writeAccess: true })],
      });
      await Promise.resolve();
      expect(gate.getPendingRequests()).toHaveLength(1);
      gate.approve(gate.getPendingRequests()[0].id);
      expect(gate.getPendingRequests()).toHaveLength(0);
      await pending;
    });

    it('getRequest 对未知 id 返回 undefined', () => {
      expect(gate.getRequest('launch_missing')).toBeUndefined();
    });
  });
});
