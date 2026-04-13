// ============================================================================
// TaskClaimService Tests
// 覆盖并发争抢、ownership check、锁过期、优先级、生命周期
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

import {
  TaskClaimService,
  type ClaimableTask,
} from '../../../src/main/agent/hybrid/taskClaimService';

function makeTask(
  id: string,
  priority: number,
  tags: string[] = [],
): ClaimableTask {
  return {
    id,
    description: `task ${id}`,
    priority,
    tags,
    createdAt: Date.now(),
  };
}

describe('TaskClaimService', () => {
  let service: TaskClaimService;

  beforeEach(() => {
    service = new TaskClaimService(/* lockTimeoutMs */ 1000);
  });

  afterEach(() => {
    service.reset();
  });

  // ==========================================================================
  // Concurrent claim race (Codex 最关心的场景)
  // ==========================================================================

  describe('并发争抢', () => {
    it('同一任务被两个 agent 同时 claim，只有一个成功', () => {
      service.addTasks([makeTask('t1', 1)]);

      const first = service.claim('t1', 'agent-a');
      const second = service.claim('t1', 'agent-b');

      expect(first).not.toBeNull();
      expect(first?.id).toBe('t1');
      expect(second).toBeNull();

      const stats = service.getStats();
      expect(stats.claimed).toBe(1);
      expect(stats.available).toBe(0);
    });

    it('claimNext 按优先级派发，同一批任务两个 agent 不重复领取', () => {
      service.addTasks([
        makeTask('low', 10),
        makeTask('high', 1),
        makeTask('mid', 5),
      ]);

      const a = service.claimNext('agent-a');
      const b = service.claimNext('agent-b');
      const c = service.claimNext('agent-c');
      const d = service.claimNext('agent-d');

      expect(a?.id).toBe('high');
      expect(b?.id).toBe('mid');
      expect(c?.id).toBe('low');
      expect(d).toBeNull();
    });

    it('preferTags 把匹配标签的任务优先派发', () => {
      service.addTasks([
        makeTask('plain', 1, []),
        makeTask('tagged', 5, ['refactor']),
      ]);

      const claimed = service.claimNext('agent-a', ['refactor']);
      expect(claimed?.id).toBe('tagged');
    });
  });

  // ==========================================================================
  // Ownership check
  // ==========================================================================

  describe('ownership check', () => {
    beforeEach(() => {
      service.addTasks([makeTask('t1', 1)]);
      service.claim('t1', 'agent-a');
    });

    it('非持有者不能 release', () => {
      expect(service.release('t1', 'agent-b')).toBe(false);
      expect(service.getStats().claimed).toBe(1);
    });

    it('非持有者不能 complete', () => {
      expect(service.complete('t1', 'agent-b', 'hijack')).toBe(false);
      expect(service.getStats().completed).toBe(0);
    });

    it('非持有者不能 fail', () => {
      expect(service.fail('t1', 'agent-b', 'nope')).toBe(false);
      expect(service.getStats().claimed).toBe(1);
    });

    it('持有者可以正常 complete', () => {
      expect(service.complete('t1', 'agent-a', 'done')).toBe(true);
      expect(service.getStats().completed).toBe(1);
    });

    it('持有者 fail 后任务回到 available 供重试', () => {
      expect(service.fail('t1', 'agent-a', 'boom')).toBe(true);
      const stats = service.getStats();
      expect(stats.available).toBe(1);
      expect(stats.claimed).toBe(0);
    });
  });

  // ==========================================================================
  // Lock expiry
  // ==========================================================================

  describe('锁过期', () => {
    it('过期的 claim 被其他 agent claim 时自动回收', async () => {
      const shortLock = new TaskClaimService(/* lockTimeoutMs */ 50);
      shortLock.addTasks([makeTask('t1', 1)]);

      const first = shortLock.claim('t1', 'agent-a');
      expect(first).not.toBeNull();

      await new Promise((r) => setTimeout(r, 80));

      const second = shortLock.claimNext('agent-b');
      expect(second?.id).toBe('t1');

      const stats = shortLock.getStats();
      expect(stats.claimed).toBe(1);
      shortLock.reset();
    });

    it('原持有者在 claim 过期后无法再 complete（因为已被回收）', async () => {
      const shortLock = new TaskClaimService(/* lockTimeoutMs */ 50);
      shortLock.addTasks([makeTask('t1', 1)]);
      shortLock.claim('t1', 'agent-a');

      await new Promise((r) => setTimeout(r, 80));
      shortLock.claimNext('agent-b'); // 过期回收并重新 claim 到 agent-b

      expect(shortLock.complete('t1', 'agent-a', 'late')).toBe(false);
      shortLock.reset();
    });
  });

  // ==========================================================================
  // Lifecycle
  // ==========================================================================

  describe('生命周期', () => {
    it('isAllDone 在空池时返回 false', () => {
      expect(service.isAllDone()).toBe(false);
    });

    it('isAllDone 在所有任务完成后返回 true', () => {
      service.addTasks([makeTask('t1', 1), makeTask('t2', 2)]);
      service.claim('t1', 'agent-a');
      service.complete('t1', 'agent-a', 'ok');
      service.claim('t2', 'agent-a');
      service.complete('t2', 'agent-a', 'ok');
      expect(service.isAllDone()).toBe(true);
    });

    it('release 让任务重新可被 claim', () => {
      service.addTasks([makeTask('t1', 1)]);
      service.claim('t1', 'agent-a');
      expect(service.release('t1', 'agent-a')).toBe(true);

      const re = service.claim('t1', 'agent-b');
      expect(re?.id).toBe('t1');
    });

    it('reset 清空所有任务', () => {
      service.addTasks([makeTask('t1', 1), makeTask('t2', 2)]);
      service.reset();
      expect(service.getStats().total).toBe(0);
    });
  });
});
