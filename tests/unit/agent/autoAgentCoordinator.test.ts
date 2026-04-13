// ============================================================================
// AutoAgentCoordinator Tests
// 覆盖 sequential/parallel 策略、checkpoint 写入与恢复、失败传播、
// 结果聚合、取消/进度查询
// ============================================================================

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

vi.mock('../../../src/main/services/infra/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// ---------------------------------------------------------------------------
// Shared mock state
// ---------------------------------------------------------------------------

const executorState = vi.hoisted(() => ({
  executeMock: vi.fn(),
}));

vi.mock('../../../src/main/agent/subagentExecutor', () => ({
  getSubagentExecutor: () => ({
    execute: executorState.executeMock,
  }),
}));

// sessionStateManager stub — in-memory agent registry
interface SubagentEntry {
  id: string;
  name: string;
  status: string;
  startedAt: number;
  completedAt?: number;
  error?: string;
}
const sessionState = vi.hoisted(() => {
  const sessions = new Map<string, { activeSubagents: Map<string, SubagentEntry> }>();

  const ensure = (id: string) => {
    if (!sessions.has(id)) {
      sessions.set(id, { activeSubagents: new Map() });
    }
    return sessions.get(id)!;
  };

  return {
    sessions,
    reset() {
      sessions.clear();
    },
    addSubagent(sid: string, sub: SubagentEntry) {
      ensure(sid).activeSubagents.set(sub.id, { ...sub });
    },
    updateSubagent(sid: string, id: string, patch: Partial<SubagentEntry>) {
      const s = ensure(sid);
      const cur = s.activeSubagents.get(id);
      if (cur) s.activeSubagents.set(id, { ...cur, ...patch });
    },
    get(sid: string) {
      return sessions.get(sid);
    },
  };
});

vi.mock('../../../src/main/session/sessionStateManager', () => ({
  getSessionStateManager: () => ({
    addSubagent: sessionState.addSubagent,
    updateSubagent: sessionState.updateSubagent,
    get: sessionState.get,
  }),
}));

// Unused-at-runtime imports still need stubs so module load doesn't pull in
// heavy dependencies.
vi.mock('../../../src/main/agent/resourceLockManager', () => ({
  getResourceLockManager: () => ({}),
}));
vi.mock('../../../src/main/agent/progressAggregator', () => ({
  createProgressAggregator: () => ({}),
}));
vi.mock('../../../src/main/agent/parallelErrorHandler', () => ({
  createParallelErrorHandler: () => ({}),
}));

// Redirect checkpoint dir to a test tmp dir
const configDirState = vi.hoisted(() => ({ dir: '' }));

vi.mock('../../../src/main/config/configPaths', () => ({
  getUserConfigDir: () => configDirState.dir,
}));

import { AutoAgentCoordinator } from '../../../src/main/agent/autoAgentCoordinator';
import type { DynamicAgentDefinition } from '../../../src/main/agent/dynamicAgentFactory';
import type {
  AgentRequirements,
  ExecutionStrategy,
} from '../../../src/main/agent/agentRequirementsAnalyzer';
import type { SubagentResult } from '../../../src/main/agent/subagentExecutor';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeAgent(
  id: string,
  overrides: Partial<DynamicAgentDefinition> = {}
): DynamicAgentDefinition {
  return {
    id,
    name: overrides.name ?? `Agent-${id}`,
    role: 'coder',
    taskDescription: `task-${id}`,
    systemPrompt: 'you are a test agent',
    tools: ['Read'],
    maxIterations: 5,
    maxBudget: 1,
    priority: 2,
    canRunParallel: false,
    ...overrides,
  } as DynamicAgentDefinition;
}

function makeContext(sessionId = 'sess-1') {
  return {
    sessionId,
    modelConfig: { provider: 'mock', model: 'mock' } as never,
    toolResolver: {} as never,
    toolContext: {} as never,
  };
}

function makeRequirements(strategy: ExecutionStrategy): AgentRequirements {
  return { executionStrategy: strategy } as AgentRequirements;
}

function makeResult(
  overrides: Partial<SubagentResult> = {}
): SubagentResult {
  return {
    success: true,
    output: 'done',
    iterations: 1,
    toolsUsed: ['Read'],
    cost: 0,
    ...overrides,
  };
}

function checkpointPath(sessionId: string): string {
  return path.join(
    configDirState.dir,
    'coordination-checkpoints',
    `${sessionId}.json`
  );
}

describe('AutoAgentCoordinator', () => {
  let coordinator: AutoAgentCoordinator;
  let tmpDir: string;

  beforeEach(() => {
    executorState.executeMock.mockReset();
    sessionState.reset();

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-coord-test-'));
    configDirState.dir = tmpDir;

    coordinator = new AutoAgentCoordinator();

    // Default: success with echoed name
    executorState.executeMock.mockImplementation(
      async (_prompt: string, spec: { name: string }) =>
        makeResult({ output: `ok:${spec.name}` })
    );
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  // ==========================================================================
  // sequential 策略
  // ==========================================================================

  describe('sequential 策略', () => {
    it('按顺序执行所有 agent 并聚合输出', async () => {
      const order: string[] = [];
      executorState.executeMock.mockImplementation(
        async (_prompt: string, spec: { name: string }) => {
          order.push(spec.name);
          return makeResult({ output: `out:${spec.name}`, iterations: 2 });
        }
      );

      const result = await coordinator.execute(
        [makeAgent('a1', { name: 'first' }), makeAgent('a2', { name: 'second' })],
        makeRequirements('sequential'),
        makeContext()
      );

      expect(order).toEqual(['first', 'second']);
      expect(result.success).toBe(true);
      expect(result.results).toHaveLength(2);
      expect(result.aggregatedOutput).toContain('first');
      expect(result.aggregatedOutput).toContain('second');
      expect(result.totalIterations).toBe(4);
    });

    it('前置任务 output 注入后置 prompt（L1 Result Passing）', async () => {
      const prompts: string[] = [];
      executorState.executeMock.mockImplementation(
        async (prompt: string, spec: { name: string }) => {
          prompts.push(prompt);
          return makeResult({ output: `${spec.name}-output` });
        }
      );

      await coordinator.execute(
        [makeAgent('a1', { name: 'first' }), makeAgent('a2', { name: 'second' })],
        makeRequirements('sequential'),
        makeContext()
      );

      expect(prompts[0]).not.toContain('前置任务输出');
      expect(prompts[1]).toContain('前置任务输出');
      expect(prompts[1]).toContain('first-output');
    });

    it('priority=1 的 agent 失败后立即停止', async () => {
      executorState.executeMock.mockImplementation(
        async (_p: string, spec: { name: string }) => {
          if (spec.name === 'primary') {
            return makeResult({ success: false, error: 'boom' });
          }
          return makeResult();
        }
      );

      const result = await coordinator.execute(
        [
          makeAgent('a1', { name: 'primary', priority: 1 }),
          makeAgent('a2', { name: 'follow-up' }),
        ],
        makeRequirements('sequential'),
        makeContext()
      );

      expect(result.results).toHaveLength(1);
      expect(result.results[0].status).toBe('failed');
      expect(executorState.executeMock).toHaveBeenCalledTimes(1);
    });

    it('非 primary 失败时继续执行后续 agent', async () => {
      executorState.executeMock
        .mockResolvedValueOnce(makeResult({ success: false, error: 'soft' }))
        .mockResolvedValueOnce(makeResult({ output: 'recovered' }));

      const result = await coordinator.execute(
        [
          makeAgent('a1', { name: 'loose', priority: 3 }),
          makeAgent('a2', { name: 'next' }),
        ],
        makeRequirements('sequential'),
        makeContext()
      );

      expect(result.results).toHaveLength(2);
      expect(executorState.executeMock).toHaveBeenCalledTimes(2);
    });

    it('executor 异常被捕获成 failed result', async () => {
      executorState.executeMock.mockRejectedValueOnce(new Error('exec crash'));

      const result = await coordinator.execute(
        [makeAgent('a1', { priority: 3 })],
        makeRequirements('sequential'),
        makeContext()
      );

      expect(result.results[0].status).toBe('failed');
      expect(result.results[0].error).toBe('exec crash');
    });

    it('onProgress 在状态变化时回调', async () => {
      const events: Array<{ id: string; status: string }> = [];
      const ctx = {
        ...makeContext(),
        onProgress: (id: string, status: string) => {
          events.push({ id, status });
        },
      };

      await coordinator.execute(
        [makeAgent('a1')],
        makeRequirements('sequential'),
        ctx
      );

      expect(events.some((e) => e.status === 'running')).toBe(true);
      expect(events.some((e) => e.status === 'completed')).toBe(true);
    });
  });

  // ==========================================================================
  // parallel 策略
  // ==========================================================================

  describe('parallel 策略', () => {
    it('主 agent 顺序执行后并行执行 canRunParallel=true 的辅助 agent', async () => {
      const invoked: string[] = [];
      executorState.executeMock.mockImplementation(
        async (_p: string, spec: { name: string }) => {
          invoked.push(spec.name);
          return makeResult({ output: spec.name });
        }
      );

      const result = await coordinator.execute(
        [
          makeAgent('main', { name: 'main', canRunParallel: false }),
          makeAgent('helper1', { name: 'helper1', canRunParallel: true }),
          makeAgent('helper2', { name: 'helper2', canRunParallel: true }),
        ],
        makeRequirements('parallel'),
        makeContext()
      );

      expect(result.results).toHaveLength(3);
      // main 必须在 helper 之前开始
      expect(invoked.indexOf('main')).toBe(0);
      expect(invoked).toContain('helper1');
      expect(invoked).toContain('helper2');
    });

    it('主 agent 失败时跳过并行辅助 agent', async () => {
      executorState.executeMock.mockImplementation(
        async (_p: string, spec: { name: string }) => {
          if (spec.name === 'main') {
            return makeResult({ success: false, error: 'main crashed' });
          }
          return makeResult();
        }
      );

      const result = await coordinator.execute(
        [
          makeAgent('main', { name: 'main', canRunParallel: false }),
          makeAgent('helper', { name: 'helper', canRunParallel: true }),
        ],
        makeRequirements('parallel'),
        makeContext()
      );

      // helper 不应被调用
      const helperCalls = executorState.executeMock.mock.calls.filter(
        ([, spec]) => (spec as { name: string }).name === 'helper'
      );
      expect(helperCalls).toHaveLength(0);
      expect(result.results.find((r) => r.agentName === 'helper')).toBeUndefined();
    });
  });

  // ==========================================================================
  // Checkpoint 写入与恢复
  // ==========================================================================

  describe('checkpoint', () => {
    it('全部成功后删除 checkpoint 文件', async () => {
      const ctx = makeContext('sess-cp-1');
      await coordinator.execute(
        [makeAgent('a1'), makeAgent('a2')],
        makeRequirements('sequential'),
        ctx
      );
      expect(fs.existsSync(checkpointPath('sess-cp-1'))).toBe(false);
    });

    it('中途进程崩溃后 checkpoint 仍保留已完成节点', async () => {
      executorState.executeMock.mockImplementation(
        async (_p: string, spec: { name: string }) =>
          makeResult({ output: `out-${spec.name}` })
      );

      // 模拟进程在 a2 开始前崩溃：onProgress(a2, running) 抛错 →
      // 穿过 executeSequential 被 execute() 的 try/catch 捕获，跳过
      // deleteCheckpoint 的清理路径
      const ctx = {
        ...makeContext('sess-cp-2'),
        onProgress: (id: string, status: string) => {
          if (id === 'a2' && status === 'running') {
            throw new Error('simulated crash');
          }
        },
      };

      const result = await coordinator.execute(
        [makeAgent('a1'), makeAgent('a2')],
        makeRequirements('sequential'),
        ctx
      );

      // execute() 的 catch 返回 success=false
      expect(result.success).toBe(false);

      // a1 已完成 → 应留在 checkpoint 里
      const cpPath = checkpointPath('sess-cp-2');
      expect(fs.existsSync(cpPath)).toBe(true);
      const cp = JSON.parse(fs.readFileSync(cpPath, 'utf-8'));
      expect(cp.sessionId).toBe('sess-cp-2');
      expect(Object.keys(cp.completedNodes)).toEqual(['a1']);
    });

    it('重启时跳过已完成节点', async () => {
      executorState.executeMock.mockImplementation(
        async (_p: string, spec: { name: string }) =>
          makeResult({ output: `first-${spec.name}` })
      );

      // 第一次：a1 执行完毕后 a2 开始前崩溃
      const firstCtx = {
        ...makeContext('sess-resume'),
        onProgress: (id: string, status: string) => {
          if (id === 'a2' && status === 'running') {
            throw new Error('crash');
          }
        },
      };
      await coordinator.execute(
        [makeAgent('a1'), makeAgent('a2')],
        makeRequirements('sequential'),
        firstCtx
      );
      expect(executorState.executeMock).toHaveBeenCalledTimes(1);

      // 第二次：重启，只应执行 a2
      executorState.executeMock.mockReset();
      executorState.executeMock.mockImplementation(
        async () => makeResult({ output: 'second-a2' })
      );

      const secondResult = await coordinator.execute(
        [makeAgent('a1'), makeAgent('a2')],
        makeRequirements('sequential'),
        makeContext('sess-resume')
      );

      // 仅 a2 被调用
      expect(executorState.executeMock).toHaveBeenCalledTimes(1);
      expect(secondResult.results).toHaveLength(2);
      const a1Result = secondResult.results.find((r) => r.agentId === 'a1');
      expect(a1Result?.result?.output).toBe('first-Agent-a1');
    });

    it('agent ids 不匹配的 checkpoint 视为作废，重新执行', async () => {
      // 预先写一个不匹配的 checkpoint
      const sid = 'sess-mismatch';
      const dir = path.join(configDirState.dir, 'coordination-checkpoints');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, `${sid}.json`),
        JSON.stringify({
          sessionId: sid,
          agentIds: ['old-x', 'old-y'],
          completedNodes: {
            'old-x': {
              agentId: 'old-x',
              agentName: 'x',
              status: 'completed',
              result: { success: true, output: 'stale', iterations: 0, toolsUsed: [], cost: 0 },
              startedAt: 0,
              completedAt: 0,
              duration: 0,
            },
          },
          createdAt: 0,
          updatedAt: 0,
        })
      );

      await coordinator.execute(
        [makeAgent('new-1'), makeAgent('new-2')],
        makeRequirements('sequential'),
        makeContext(sid)
      );

      // 两个新 agent 都应被执行
      expect(executorState.executeMock).toHaveBeenCalledTimes(2);
    });
  });

  // ==========================================================================
  // 结果聚合
  // ==========================================================================

  describe('结果聚合', () => {
    it('totalCost/totalIterations 按 agent 累加', async () => {
      executorState.executeMock
        .mockResolvedValueOnce(
          makeResult({ iterations: 3, cost: 0.05, output: 'o1' })
        )
        .mockResolvedValueOnce(
          makeResult({ iterations: 7, cost: 0.12, output: 'o2' })
        );

      const result = await coordinator.execute(
        [makeAgent('a1'), makeAgent('a2')],
        makeRequirements('sequential'),
        makeContext()
      );

      expect(result.totalIterations).toBe(10);
      expect(result.totalCost).toBeCloseTo(0.17, 5);
    });

    it('errors 数组收集每个失败 agent 的 error', async () => {
      executorState.executeMock
        .mockResolvedValueOnce(makeResult())
        .mockResolvedValueOnce(makeResult({ success: false, error: 'ouch' }));

      const result = await coordinator.execute(
        [makeAgent('a1', { priority: 3 }), makeAgent('a2', { priority: 3 })],
        makeRequirements('sequential'),
        makeContext()
      );

      expect(result.errors.some((e) => e.includes('ouch'))).toBe(true);
    });

    it('至少一个 agent 成功时整体 success=true', async () => {
      executorState.executeMock
        .mockResolvedValueOnce(makeResult())
        .mockResolvedValueOnce(makeResult({ success: false, error: 'half' }));

      const result = await coordinator.execute(
        [makeAgent('a1', { priority: 3 }), makeAgent('a2', { priority: 3 })],
        makeRequirements('sequential'),
        makeContext()
      );

      expect(result.success).toBe(true);
    });
  });

  // ==========================================================================
  // 取消与进度查询
  // ==========================================================================

  describe('cancelAgents / getProgress', () => {
    it('cancelAgents 把 session 内所有 subagent 标为 failed', async () => {
      await coordinator.execute(
        [makeAgent('a1'), makeAgent('a2')],
        makeRequirements('sequential'),
        makeContext('sess-cancel')
      );

      coordinator.cancelAgents('sess-cancel');

      const state = sessionState.get('sess-cancel');
      expect(state).toBeDefined();
      for (const sub of state!.activeSubagents.values()) {
        expect(sub.status).toBe('failed');
        expect(sub.error).toBe('Cancelled by user');
      }
    });

    it('getProgress 返回 session 状态统计', async () => {
      await coordinator.execute(
        [makeAgent('a1'), makeAgent('a2')],
        makeRequirements('sequential'),
        makeContext('sess-progress')
      );

      const progress = coordinator.getProgress('sess-progress');
      expect(progress.total).toBe(2);
      expect(progress.completed).toBe(2);
    });

    it('getProgress 对未知 session 返回全零', () => {
      const p = coordinator.getProgress('unknown');
      expect(p).toEqual({
        total: 0,
        completed: 0,
        running: 0,
        failed: 0,
        pending: 0,
      });
    });
  });
});
