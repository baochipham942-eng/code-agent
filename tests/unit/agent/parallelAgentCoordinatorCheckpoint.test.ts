// ============================================================================
// ParallelAgentCoordinator Checkpoint Tests (ADR-010 item #3)
// 覆盖：
// - persistCheckpoint 写盘 + schema shape
// - restoreCheckpoint 重建 completedTasks / taskDefinitions / sharedContext
// - 重启后 executeParallel 跳过已完成节点、重跑 runningAtCrash 任务
// - version 不匹配 / JSON 损坏 / 文件缺失 → 静默 false，不抛
// - 多次 save 幂等（后一次覆盖前一次）
// - 成功收尾自动清理 checkpoint 文件
// ============================================================================

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fsPromises } from 'fs';
import * as path from 'path';
import * as os from 'os';

vi.mock('../../../src/main/services/infra/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// ---------------------------------------------------------------------------
// 将 user config dir 重定向到每个用例独立的 tmp 目录
// ---------------------------------------------------------------------------

const configDirState = vi.hoisted(() => ({ dir: '' }));

vi.mock('../../../src/main/config/configPaths', () => ({
  getUserConfigDir: () => configDirState.dir,
  getUserConfigDirLegacy: () => configDirState.dir,
}));

// ---------------------------------------------------------------------------
// Mock subagentExecutor —— 每次 execute 都按 spec.name 返回成功结果
// ---------------------------------------------------------------------------

const executorState = vi.hoisted(() => ({
  executeMock: vi.fn(),
}));

vi.mock('../../../src/main/agent/subagentExecutor', () => ({
  getSubagentExecutor: () => ({
    execute: executorState.executeMock,
  }),
}));

// ---------------------------------------------------------------------------
// Mock scheduler —— checkpoint 测试不关心 DAG 路径的内部
// ---------------------------------------------------------------------------

// hoisted DAG state 暴露给测试断言：记录 prefeed 时 dag.completeTask 的入参
const dagState = vi.hoisted(() => ({
  completedCalls: [] as Array<{ id: string; output: unknown }>,
  taskMetadata: new Map<string, { startedAt?: number; completedAt?: number; duration?: number }>(),
}));

vi.mock('../../../src/main/scheduler', () => ({
  TaskDAG: class {
    private addedIds: string[] = [];
    constructor() {}
    addAgentTask(id: string): void {
      this.addedIds.push(id);
    }
    validate() { return { valid: true, errors: [] }; }
    getAllTasks() { return []; }
    completeTask(id: string, output: unknown): void {
      dagState.completedCalls.push({ id, output });
      if (!dagState.taskMetadata.has(id)) {
        dagState.taskMetadata.set(id, {});
      }
    }
    getTask(id: string): { metadata: { startedAt?: number; completedAt?: number; duration?: number } } | undefined {
      let meta = dagState.taskMetadata.get(id);
      if (!meta) {
        meta = {};
        dagState.taskMetadata.set(id, meta);
      }
      return { metadata: meta };
    }
  },
  getDAGScheduler: () => ({
    execute: async () => ({
      success: true,
      dag: { getAllTasks: () => [] },
      totalDuration: 0,
      maxParallelism: 0,
    }),
  }),
}));

import {
  ParallelAgentCoordinator,
  type AgentTask,
  type AgentTaskResult,
} from '../../../src/main/agent/parallelAgentCoordinator';
import { COORDINATION_CHECKPOINTS } from '../../../src/shared/constants';

function makeContext(sessionId: string) {
  return {
    modelConfig: { provider: 'mock', model: 'mock-model' } as never,
    toolResolver: {} as never,
    toolContext: {
      currentToolCallId: 'call-1',
      hookManager: undefined,
      sessionId,
    } as never,
  };
}

function makeTask(id: string, overrides: Partial<AgentTask> = {}): AgentTask {
  return {
    id,
    role: 'coder',
    task: `task description for ${id}`,
    tools: ['Read'],
    ...overrides,
  };
}

function checkpointPath(sessionId: string): string {
  return path.join(
    configDirState.dir,
    COORDINATION_CHECKPOINTS.PARALLEL_DIR,
    `${sessionId}.json`
  );
}

async function waitForPersist(): Promise<void> {
  // schedulePersist 是 fire-and-forget，等 microtask 队列排空再检查文件
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

describe('ParallelAgentCoordinator Checkpoint (ADR-010 #3)', () => {
  let coordinator: ParallelAgentCoordinator;

  beforeEach(async () => {
    configDirState.dir = await fsPromises.mkdtemp(
      path.join(os.tmpdir(), 'parallel-coord-checkpoint-')
    );

    dagState.completedCalls.length = 0;
    dagState.taskMetadata.clear();

    executorState.executeMock.mockReset();
    executorState.executeMock.mockImplementation(
      async (_task: string, spec: { name: string }) => ({
        success: true,
        output: `ok:${spec.name}`,
        iterations: 1,
        toolsUsed: ['Read'],
        cost: 0,
      })
    );

    coordinator = new ParallelAgentCoordinator({
      maxParallelTasks: 4,
      taskTimeout: 5_000,
      enableSharedContext: true,
      aggregateResults: false,
    });
    coordinator.initialize(makeContext('session-a'));
  });

  afterEach(async () => {
    coordinator.reset();
    if (configDirState.dir) {
      await fsPromises.rm(configDirState.dir, { recursive: true, force: true });
    }
  });

  // --------------------------------------------------------------------------
  // 基础持久化
  // --------------------------------------------------------------------------

  describe('persistCheckpoint', () => {
    it('无 sessionId 时静默跳过，不创建文件', async () => {
      await coordinator.persistCheckpoint('');
      const files = await fsPromises.readdir(configDirState.dir).catch(() => []);
      expect(files).not.toContain(COORDINATION_CHECKPOINTS.PARALLEL_DIR);
    });

    it('落盘 schema 包含 version / taskDefinitions / completedTasks / sharedContext', async () => {
      const tasks = [makeTask('t1'), makeTask('t2', { dependsOn: ['t1'] })];
      await coordinator.executeParallel(tasks);

      // executeParallel 全部成功时已自动删除，这里重新手动 persist 一次
      await coordinator.persistCheckpoint('session-a');
      const raw = await fsPromises.readFile(checkpointPath('session-a'), 'utf-8');
      const snapshot = JSON.parse(raw);

      expect(snapshot.version).toBe(COORDINATION_CHECKPOINTS.SCHEMA_VERSION);
      expect(snapshot.sessionId).toBe('session-a');
      expect(Array.isArray(snapshot.taskDefinitions)).toBe(true);
      expect(snapshot.taskDefinitions).toHaveLength(2);
      expect(Array.isArray(snapshot.completedTasks)).toBe(true);
      expect(snapshot.completedTasks.map((e: [string, AgentTaskResult]) => e[0])).toEqual(
        expect.arrayContaining(['t1', 't2'])
      );
      expect(snapshot.sharedContext).toBeDefined();
      expect(snapshot.sharedContext.findings).toBeDefined();
    });

    it('节点完成后 fire-and-forget 自动写盘', async () => {
      // 把"t1 完成时 checkpoint 已落盘"的观察值 capture 到外部变量，主测试体
      // 在 executeParallel 收尾后再断言。早先版本在 t2 mock 内 expect，会和
      // executeTask 的 runningTasks.then 孤儿 promise 形成 race，污染 vitest
      // unhandled rejection。这里改成只采样不断言，避免 fixture 脆弱性
      let t1CheckpointVisibleWhenT2Started = false;

      executorState.executeMock.mockImplementationOnce(async () => ({
        success: true,
        output: 'found issue in file path: /tmp/a.ts',
        iterations: 1,
        toolsUsed: ['Read'],
        cost: 0,
      }));
      executorState.executeMock.mockImplementationOnce(async () => {
        await waitForPersist();
        t1CheckpointVisibleWhenT2Started = await fsPromises
          .stat(checkpointPath('session-a'))
          .then(() => true)
          .catch(() => false);
        return {
          success: true,
          output: 'ok:t2',
          iterations: 1,
          toolsUsed: ['Read'],
          cost: 0,
        };
      });

      await coordinator.executeParallel([
        makeTask('t1'),
        makeTask('t2', { dependsOn: ['t1'] }),
      ]);

      expect(t1CheckpointVisibleWhenT2Started).toBe(true);
    });

    it('多次 save 幂等，后一次覆盖前一次', async () => {
      await coordinator.persistCheckpoint('session-a');
      const first = JSON.parse(
        await fsPromises.readFile(checkpointPath('session-a'), 'utf-8')
      );
      expect(first.completedTasks).toHaveLength(0);

      // 注入一个 completed 再 save
      (coordinator as unknown as {
        completedTasks: Map<string, AgentTaskResult>;
      }).completedTasks.set('t1', {
        success: true,
        output: 'manual',
        iterations: 1,
        toolsUsed: [],
        taskId: 't1',
        role: 'coder',
        startTime: 0,
        endTime: 1,
        duration: 1,
      });
      await coordinator.persistCheckpoint('session-a');

      const second = JSON.parse(
        await fsPromises.readFile(checkpointPath('session-a'), 'utf-8')
      );
      expect(second.completedTasks).toHaveLength(1);
      expect(second.completedTasks[0][0]).toBe('t1');
    });
  });

  // --------------------------------------------------------------------------
  // 恢复
  // --------------------------------------------------------------------------

  describe('restoreCheckpoint', () => {
    it('文件不存在 → 返回 false，不抛', async () => {
      const fresh = new ParallelAgentCoordinator();
      fresh.initialize(makeContext('session-missing'));
      const ok = await fresh.restoreCheckpoint('session-missing');
      expect(ok).toBe(false);
    });

    it('JSON 损坏 → 返回 false，不抛', async () => {
      const filePath = checkpointPath('session-a');
      await fsPromises.mkdir(path.dirname(filePath), { recursive: true });
      await fsPromises.writeFile(filePath, '{not valid json', 'utf-8');

      const ok = await coordinator.restoreCheckpoint('session-a');
      expect(ok).toBe(false);
    });

    it('version 不匹配 → 视为 stale，返回 false', async () => {
      const filePath = checkpointPath('session-a');
      await fsPromises.mkdir(path.dirname(filePath), { recursive: true });
      await fsPromises.writeFile(
        filePath,
        JSON.stringify({
          version: 999,
          sessionId: 'session-a',
          createdAt: 1,
          updatedAt: 1,
          taskDefinitions: [],
          completedTasks: [],
          runningTaskIds: [],
          sharedContext: { findings: {}, files: {}, decisions: {}, errors: [] },
        }),
        'utf-8'
      );

      const ok = await coordinator.restoreCheckpoint('session-a');
      expect(ok).toBe(false);
    });

    it('读不懂的额外字段被忽略，核心字段正常恢复（向前兼容）', async () => {
      const filePath = checkpointPath('session-a');
      await fsPromises.mkdir(path.dirname(filePath), { recursive: true });
      await fsPromises.writeFile(
        filePath,
        JSON.stringify({
          version: COORDINATION_CHECKPOINTS.SCHEMA_VERSION,
          sessionId: 'session-a',
          createdAt: 1,
          updatedAt: 2,
          taskDefinitions: [['t1', makeTask('t1')]],
          completedTasks: [
            [
              't1',
              {
                success: true,
                output: 'prior output',
                iterations: 3,
                toolsUsed: [],
                taskId: 't1',
                role: 'coder',
                startTime: 0,
                endTime: 0,
                duration: 0,
              },
            ],
          ],
          runningTaskIds: [],
          sharedContext: { findings: {}, files: {}, decisions: {}, errors: [] },
          futureField: 'should be ignored without crashing',
        }),
        'utf-8'
      );

      const ok = await coordinator.restoreCheckpoint('session-a');
      expect(ok).toBe(true);
      expect(coordinator.getCompletedTasks()).toHaveLength(1);
      expect(coordinator.getTaskDefinition('t1')?.id).toBe('t1');
    });

    it('恢复后 executeParallel 跳过已完成节点、重跑未完成节点', async () => {
      // 预埋一个 "t1 已完成" 的快照
      const filePath = checkpointPath('session-a');
      await fsPromises.mkdir(path.dirname(filePath), { recursive: true });
      await fsPromises.writeFile(
        filePath,
        JSON.stringify({
          version: COORDINATION_CHECKPOINTS.SCHEMA_VERSION,
          sessionId: 'session-a',
          createdAt: 1,
          updatedAt: 2,
          taskDefinitions: [['t1', makeTask('t1')]],
          completedTasks: [
            [
              't1',
              {
                success: true,
                output: 'restored t1 output',
                iterations: 1,
                toolsUsed: [],
                taskId: 't1',
                role: 'coder',
                startTime: 10,
                endTime: 20,
                duration: 10,
              },
            ],
          ],
          runningTaskIds: ['t2'], // 崩溃时 t2 还在跑
          sharedContext: { findings: {}, files: {}, decisions: {}, errors: [] },
        }),
        'utf-8'
      );

      const ok = await coordinator.restoreCheckpoint('session-a');
      expect(ok).toBe(true);

      const result = await coordinator.executeParallel([
        makeTask('t1'),
        makeTask('t2', { dependsOn: ['t1'] }),
      ]);

      // executeMock 应只被 t2 调用，t1 走了 checkpoint 短路
      expect(executorState.executeMock).toHaveBeenCalledTimes(1);
      // 输出里 t1 是恢复的那个
      const t1Result = result.results.find((r) => r.taskId === 't1');
      expect(t1Result?.output).toBe('restored t1 output');
      // t2 重新执行成功
      const t2Result = result.results.find((r) => r.taskId === 't2');
      expect(t2Result?.success).toBe(true);
    });

    it('恢复 sharedContext 的 findings / files / errors', async () => {
      const filePath = checkpointPath('session-a');
      await fsPromises.mkdir(path.dirname(filePath), { recursive: true });
      await fsPromises.writeFile(
        filePath,
        JSON.stringify({
          version: COORDINATION_CHECKPOINTS.SCHEMA_VERSION,
          sessionId: 'session-a',
          createdAt: 0,
          updatedAt: 0,
          taskDefinitions: [],
          completedTasks: [],
          runningTaskIds: [],
          sharedContext: {
            findings: { prior_coder_t1: 'discovered bug in auth flow' },
            files: { '/src/auth.ts': 'coder' },
            decisions: { scope: 'widen' },
            errors: ['[tester] flaky test'],
          },
        }),
        'utf-8'
      );

      const ok = await coordinator.restoreCheckpoint('session-a');
      expect(ok).toBe(true);

      const ctx = coordinator.getSharedContext();
      expect(ctx.findings.get('prior_coder_t1')).toBe('discovered bug in auth flow');
      expect(ctx.files.get('/src/auth.ts')).toBe('coder');
      expect(ctx.decisions.get('scope')).toBe('widen');
      expect(ctx.errors).toContain('[tester] flaky test');
    });
  });

  // --------------------------------------------------------------------------
  // 清理语义
  // --------------------------------------------------------------------------

  describe('cleanup after success', () => {
    it('executeParallel 全部成功后自动删除 checkpoint 文件', async () => {
      await coordinator.executeParallel([makeTask('t1'), makeTask('t2')]);
      await waitForPersist();

      const exists = await fsPromises
        .stat(checkpointPath('session-a'))
        .then(() => true)
        .catch(() => false);
      expect(exists).toBe(false);
    });

    it('executeParallel 含失败节点时保留 checkpoint 文件', async () => {
      executorState.executeMock.mockImplementationOnce(async () => ({
        success: false,
        output: '',
        error: 'mock failure',
        iterations: 0,
        toolsUsed: [],
        cost: 0,
      }));
      executorState.executeMock.mockImplementationOnce(async () => ({
        success: true,
        output: 'ok:t2',
        iterations: 1,
        toolsUsed: [],
        cost: 0,
      }));

      await coordinator.executeParallel([makeTask('t1'), makeTask('t2')]);
      await waitForPersist();

      const exists = await fsPromises
        .stat(checkpointPath('session-a'))
        .then(() => true)
        .catch(() => false);
      expect(exists).toBe(true);
    });

    it('deleteCheckpoint 对不存在的文件静默处理', async () => {
      await expect(
        coordinator.deleteCheckpoint('session-never-saved')
      ).resolves.toBeUndefined();
    });
  });

  // --------------------------------------------------------------------------
  // DAG 路径 restore 闭环（ADR-010 #3 收尾）
  // --------------------------------------------------------------------------

  describe('executeWithDAG restore (ADR-010 #3 收尾)', () => {
    it('已完成节点在进 scheduler 前被预喂给 DAG，并保留原始时间戳', async () => {
      // 预埋 t1 已完成的快照
      const filePath = checkpointPath('session-a');
      await fsPromises.mkdir(path.dirname(filePath), { recursive: true });
      await fsPromises.writeFile(
        filePath,
        JSON.stringify({
          version: COORDINATION_CHECKPOINTS.SCHEMA_VERSION,
          sessionId: 'session-a',
          createdAt: 0,
          updatedAt: 0,
          taskDefinitions: [['t1', makeTask('t1')], ['t2', makeTask('t2')]],
          completedTasks: [
            [
              't1',
              {
                success: true,
                output: 'restored-dag-t1',
                iterations: 3,
                toolsUsed: ['Read', 'Grep'],
                taskId: 't1',
                role: 'coder',
                startTime: 1000,
                endTime: 1500,
                duration: 500,
              } satisfies AgentTaskResult,
            ],
            [
              't2',
              {
                // 失败节点不应被预喂
                success: false,
                output: '',
                error: 'prior failure',
                iterations: 0,
                toolsUsed: [],
                taskId: 't2',
                role: 'coder',
                startTime: 0,
                endTime: 0,
                duration: 0,
              } satisfies AgentTaskResult,
            ],
          ],
          runningTaskIds: [],
          sharedContext: { findings: {}, files: {}, decisions: {}, errors: [] },
        }),
        'utf-8'
      );

      const ok = await coordinator.restoreCheckpoint('session-a');
      expect(ok).toBe(true);

      await coordinator.executeWithDAG([
        makeTask('t1'),
        makeTask('t2', { dependsOn: ['t1'] }),
      ]);

      // 只有成功的 t1 被预喂进 DAG，失败的 t2 留给 scheduler 重跑
      expect(dagState.completedCalls).toHaveLength(1);
      expect(dagState.completedCalls[0].id).toBe('t1');
      expect(dagState.completedCalls[0].output).toEqual({
        text: 'restored-dag-t1',
        toolsUsed: ['Read', 'Grep'],
        iterations: 3,
      });

      // metadata 用 cached 的原始时间戳覆盖了 completeTask 默认写的 now
      const t1Meta = dagState.taskMetadata.get('t1');
      expect(t1Meta?.startedAt).toBe(1000);
      expect(t1Meta?.completedAt).toBe(1500);
      expect(t1Meta?.duration).toBe(500);
    });

    it('completedTasks 为空时不预喂任何节点', async () => {
      await coordinator.executeWithDAG([makeTask('t1'), makeTask('t2')]);
      expect(dagState.completedCalls).toHaveLength(0);
    });
  });
});
