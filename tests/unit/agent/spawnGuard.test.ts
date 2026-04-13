// ============================================================================
// SpawnGuard Tests
// 覆盖并发配额、生命周期、消息队列、通知、持久化恢复
// ============================================================================

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';

vi.mock('../../../src/main/services/infra/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import {
  getSpawnGuard,
  resetSpawnGuard,
  createTextMessage,
  createAgentMessage,
} from '../../../src/main/agent/spawnGuard';
import type { SubagentResult } from '../../../src/main/agent/subagentExecutor';

type Guard = ReturnType<typeof getSpawnGuard>;

function makeResult(overrides: Partial<SubagentResult> = {}): SubagentResult {
  return {
    success: true,
    output: 'done',
    iterations: 1,
    toolsUsed: ['Read'],
    cost: 0,
    ...overrides,
  };
}

/**
 * Register an agent whose promise is resolved immediately, then wait a tick
 * so the `.then` chain inside register() can flip status to completed/failed.
 */
async function registerSettled(
  guard: Guard,
  id: string,
  role: string,
  result: SubagentResult
): Promise<void> {
  const controller = new AbortController();
  guard.register(id, role, `task-${id}`, Promise.resolve(result), controller);
  await Promise.resolve();
  await Promise.resolve();
}

async function registerRejected(
  guard: Guard,
  id: string,
  role: string,
  err: Error
): Promise<void> {
  const controller = new AbortController();
  guard.register(id, role, `task-${id}`, Promise.reject(err), controller);
  await Promise.resolve();
  await Promise.resolve();
}

describe('SpawnGuard', () => {
  let guard: Guard;

  beforeEach(() => {
    resetSpawnGuard();
    guard = getSpawnGuard({ maxAgents: 3, maxDepth: 2 });
  });

  afterEach(() => {
    resetSpawnGuard();
  });

  // ==========================================================================
  // 并发配额
  // ==========================================================================

  describe('并发配额', () => {
    it('空池时 canSpawn 返回 true，getMaxAgents 反映构造配置', () => {
      expect(guard.canSpawn()).toBe(true);
      expect(guard.getMaxAgents()).toBe(3);
      expect(guard.getRunningCount()).toBe(0);
    });

    it('达到 maxAgents 后 canSpawn 返回 false', () => {
      // Use pending promises to keep them in running state
      const pending = new Promise<SubagentResult>(() => {});
      guard.register('a1', 'coder', 't1', pending, new AbortController());
      guard.register('a2', 'coder', 't2', pending, new AbortController());
      guard.register('a3', 'coder', 't3', pending, new AbortController());

      expect(guard.getRunningCount()).toBe(3);
      expect(guard.canSpawn()).toBe(false);
    });

    it('已完成的 agent 不再占用配额', async () => {
      const pending = new Promise<SubagentResult>(() => {});
      guard.register('a1', 'coder', 't1', pending, new AbortController());
      guard.register('a2', 'coder', 't2', pending, new AbortController());
      await registerSettled(guard, 'a3', 'coder', makeResult());

      expect(guard.getRunningCount()).toBe(2);
      expect(guard.canSpawn()).toBe(true);
    });

    it('checkDepth 以 maxDepth 为上限', () => {
      expect(guard.checkDepth(1)).toBe(true);
      expect(guard.checkDepth(2)).toBe(true);
      expect(guard.checkDepth(3)).toBe(false);
    });
  });

  // ==========================================================================
  // 生命周期 & 自动状态转换
  // ==========================================================================

  describe('生命周期', () => {
    it('promise resolve(success=true) 将状态转为 completed 并记录 result', async () => {
      await registerSettled(
        guard,
        'a1',
        'coder',
        makeResult({ output: 'ok', iterations: 5 })
      );

      const a = guard.get('a1');
      expect(a?.status).toBe('completed');
      expect(a?.result?.output).toBe('ok');
      expect(a?.completedAt).toBeTypeOf('number');
    });

    it('promise resolve(success=false) 将状态转为 failed 并保留 error', async () => {
      await registerSettled(
        guard,
        'a1',
        'coder',
        makeResult({ success: false, error: 'tool error' })
      );

      const a = guard.get('a1');
      expect(a?.status).toBe('failed');
      expect(a?.error).toBe('tool error');
    });

    it('promise reject 将状态转为 failed 并记录异常 message', async () => {
      await registerRejected(guard, 'a1', 'coder', new Error('boom'));

      const a = guard.get('a1');
      expect(a?.status).toBe('failed');
      expect(a?.error).toBe('boom');
    });

    it('cancel 正在运行的 agent 触发 abort + 状态转 cancelled', () => {
      const pending = new Promise<SubagentResult>(() => {});
      const controller = new AbortController();
      guard.register('a1', 'coder', 't1', pending, controller);

      expect(guard.cancel('a1')).toBe(true);
      expect(controller.signal.aborted).toBe(true);
      expect(guard.get('a1')?.status).toBe('cancelled');
    });

    it('cancel 已完成的 agent 返回 false', async () => {
      await registerSettled(guard, 'a1', 'coder', makeResult());
      expect(guard.cancel('a1')).toBe(false);
    });

    it('onComplete 回调在 agent 结束后触发', async () => {
      const cb = vi.fn();
      guard.onComplete(cb);

      await registerSettled(guard, 'a1', 'coder', makeResult());

      expect(cb).toHaveBeenCalledTimes(1);
      expect(cb.mock.calls[0][0].id).toBe('a1');
    });

    it('onComplete 抛错不会影响其他回调', async () => {
      const good = vi.fn();
      guard.onComplete(() => {
        throw new Error('cb fail');
      });
      guard.onComplete(good);

      await registerSettled(guard, 'a1', 'coder', makeResult());

      expect(good).toHaveBeenCalledTimes(1);
    });

    it('waitFor 在全部完成后立即返回', async () => {
      await registerSettled(guard, 'a1', 'coder', makeResult());
      await registerSettled(guard, 'a2', 'coder', makeResult());

      const map = await guard.waitFor(['a1', 'a2'], 1000);
      expect(map.size).toBe(2);
      expect(map.get('a1')?.status).toBe('completed');
      expect(map.get('a2')?.status).toBe('completed');
    });

    it('waitFor 超时后返回仍在 running 的 agent 当前快照', async () => {
      const pending = new Promise<SubagentResult>(() => {});
      guard.register('a1', 'coder', 't1', pending, new AbortController());

      const map = await guard.waitFor(['a1'], 30);
      expect(map.get('a1')?.status).toBe('running');
    });
  });

  // ==========================================================================
  // 消息队列
  // ==========================================================================

  describe('消息队列', () => {
    beforeEach(() => {
      const pending = new Promise<SubagentResult>(() => {});
      guard.register('a1', 'coder', 't1', pending, new AbortController());
    });

    it('sendMessage string 转为 text message 入队', () => {
      expect(guard.sendMessage('a1', 'hello')).toBe(true);
      const msgs = guard.drainMessages('a1');
      expect(msgs).toHaveLength(1);
      expect(msgs[0].type).toBe('text');
      expect(msgs[0].payload).toBe('hello');
    });

    it('sendMessage 非 running agent 返回 false', async () => {
      await registerSettled(guard, 'a2', 'coder', makeResult());
      expect(guard.sendMessage('a2', 'late')).toBe(false);
    });

    it('sendStructuredMessage 按 type 入队', () => {
      guard.sendStructuredMessage('a1', 'shutdown_request', 'parent', {
        reason: 'done',
      });
      const msgs = guard.drainMessages('a1');
      expect(msgs[0].type).toBe('shutdown_request');
      expect(JSON.parse(msgs[0].payload)).toEqual({ reason: 'done' });
    });

    it('drainMessages 清空队列', () => {
      guard.sendMessage('a1', 'm1');
      guard.sendMessage('a1', 'm2');
      expect(guard.drainMessages('a1')).toHaveLength(2);
      expect(guard.drainMessages('a1')).toHaveLength(0);
    });

    it('drainMessagesByType 只抽取匹配类型，其余保留', () => {
      guard.sendMessage('a1', createTextMessage('parent', 'hi'));
      guard.sendMessage(
        'a1',
        createAgentMessage('shutdown_request', 'parent', { reason: 'stop' })
      );

      const shutdowns = guard.drainMessagesByType('a1', 'shutdown_request');
      expect(shutdowns).toHaveLength(1);
      expect(shutdowns[0].type).toBe('shutdown_request');

      const rest = guard.drainMessages('a1');
      expect(rest).toHaveLength(1);
      expect(rest[0].type).toBe('text');
    });
  });

  // ==========================================================================
  // 通知 + 依赖检查
  // ==========================================================================

  describe('通知与依赖', () => {
    it('agent 完成后 pendingNotifications 自动入队', async () => {
      await registerSettled(guard, 'a1', 'coder', makeResult());
      const notes = guard.drainNotifications();
      expect(notes).toHaveLength(1);
      expect(notes[0]).toContain('<subagent_notification>');
      expect(notes[0]).toContain('"agent_id"');
      expect(notes[0]).toContain('a1');
    });

    it('drainNotifications 二次调用返回空', async () => {
      await registerSettled(guard, 'a1', 'coder', makeResult());
      guard.drainNotifications();
      expect(guard.drainNotifications()).toEqual([]);
    });

    it('isTaskReady 在 blocker running 时返回 false', () => {
      const pending = new Promise<SubagentResult>(() => {});
      guard.register('blocker', 'coder', 't', pending, new AbortController());
      expect(guard.isTaskReady('child', new Set(['blocker']))).toBe(false);
    });

    it('isTaskReady 在所有 blocker 完成后返回 true', async () => {
      await registerSettled(guard, 'blocker', 'coder', makeResult());
      expect(guard.isTaskReady('child', new Set(['blocker']))).toBe(true);
    });
  });

  // ==========================================================================
  // 清理 + 工具黑名单
  // ==========================================================================

  describe('清理与工具黑名单', () => {
    it('cleanup 移除超期的完成态 agent', async () => {
      await registerSettled(guard, 'a1', 'coder', makeResult());
      const a = guard.get('a1');
      // Backdate createdAt so it's older than maxAge
      if (a) a.createdAt = Date.now() - 10_000;

      const removed = guard.cleanup(1_000);
      expect(removed).toBe(1);
      expect(guard.get('a1')).toBeUndefined();
    });

    it('cleanup 不会移除 running agent', () => {
      const pending = new Promise<SubagentResult>(() => {});
      guard.register('a1', 'coder', 't1', pending, new AbortController());
      const a = guard.get('a1');
      if (a) a.createdAt = Date.now() - 10_000;

      expect(guard.cleanup(1_000)).toBe(0);
      expect(guard.get('a1')).toBeDefined();
    });

    it('getDisabledTools 包含 spawn_agent 禁用项', () => {
      const disabled = guard.getDisabledTools();
      expect(disabled).toContain('spawn_agent');
      expect(disabled).toContain('AgentSpawn');
      expect(disabled).toContain('Task');
    });

    it('getReadonlyDisabledTools 额外包含写入类工具', () => {
      const readonly = guard.getReadonlyDisabledTools();
      expect(readonly).toContain('Write');
      expect(readonly).toContain('Edit');
      // 仍然包含基础黑名单
      expect(readonly).toContain('spawn_agent');
    });
  });

  // ==========================================================================
  // 持久化 & 恢复
  // ==========================================================================

  describe('持久化与恢复', () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spawn-guard-test-'));
    });

    afterEach(() => {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    });

    it('persistState 写入 JSON 并包含 agent 元数据', async () => {
      await registerSettled(guard, 'a1', 'coder', makeResult({ output: 'hi' }));
      guard.sendMessage('a1', 'queued-after-complete');

      await guard.persistState(tmpDir);

      const filePath = path.join(tmpDir, 'spawn-guard-state.json');
      expect(fs.existsSync(filePath)).toBe(true);

      const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      expect(raw.agents).toHaveLength(1);
      expect(raw.agents[0].id).toBe('a1');
      expect(raw.agents[0].status).toBe('completed');
      expect(raw.pendingNotifications.length).toBeGreaterThan(0);
    });

    // SpawnGuard class is not exported; reach the static restoreState through
    // the constructor of a live instance.
    const getSpawnGuardCtor = (): {
      restoreState: (dir: string) => Promise<Guard | null>;
    } => {
      const instance = getSpawnGuard();
      return instance.constructor as unknown as {
        restoreState: (dir: string) => Promise<Guard | null>;
      };
    };

    it('restoreState 将 running agent 标为 failed（进程重启中断）', async () => {
      const pending = new Promise<SubagentResult>(() => {});
      guard.register('a1', 'coder', 'long-running', pending, new AbortController());

      await guard.persistState(tmpDir);

      const SpawnGuardClass = getSpawnGuardCtor();
      const restored = await SpawnGuardClass.restoreState(tmpDir);

      expect(restored).not.toBeNull();
      const a = restored!.get('a1');
      expect(a?.status).toBe('failed');
      expect(a?.error).toMatch(/Interrupted/);
    });

    it('restoreState 对不存在的 state 文件返回 null', async () => {
      const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'spawn-guard-empty-'));
      try {
        const SpawnGuardClass = getSpawnGuardCtor();
        const restored = await SpawnGuardClass.restoreState(empty);
        expect(restored).toBeNull();
      } finally {
        fs.rmSync(empty, { recursive: true, force: true });
      }
    });
  });
});
