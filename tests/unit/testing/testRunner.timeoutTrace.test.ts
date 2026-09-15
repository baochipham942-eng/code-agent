// ============================================================================
// N-EVAL-TIMEOUT-K1-TRACE：超时题保全被掐那一轮的轨迹
// ============================================================================
// 超时前 withTimeout 抛错，adapter 局部数组里的工具调用没人接，结果 toolExecutions=[]
// 而遥测里有 3~10 次真实调用（设计稿 §2）。runner 掐 run 后限时等原 sendMessage 返回并入。
// ============================================================================
import { describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import { TestRunner, type AgentInterface } from '../../../src/host/testing/testRunner';
import type { ToolExecutionRecord } from '../../../src/host/testing/types';

vi.mock('../../../src/host/services/core/databaseService', () => ({
  getDatabase: () => ({ insertExperiment: vi.fn(), insertExperimentCases: vi.fn() }),
}));

vi.mock('../../../src/shared/constants/timeouts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/shared/constants/timeouts')>();
  return { ...actual, TEST_TIMEOUTS: { ...actual.TEST_TIMEOUTS, TIMEOUT_TRACE_GRACE: 100 } };
});

function suiteYaml(followUp: boolean): string {
  return [
    'name: timeout-trace',
    'cases:',
    '  - id: slow-case',
    '    type: task',
    '    description: tool calls keep coming past the case budget',
    '    prompt: do work',
    ...(followUp ? ['    follow_up_prompts:', '      - keep going'] : []),
    '    expect:',
    '      response_contains: [done]',
    '',
  ].join('\n');
}

async function runWith(agent: AgentInterface, timeout: number, followUp = false) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'code-agent-timeout-trace-'));
  const casesDir = path.join(root, 'cases');
  await mkdir(casesDir, { recursive: true });
  await writeFile(path.join(casesDir, 'suite.yaml'), suiteYaml(followUp));
  const runner = new TestRunner({
    testCaseDir: casesDir,
    resultsDir: path.join(root, 'results'),
    workingDirectory: root,
    defaultTimeout: timeout,
    stopOnFailure: false,
    verbose: false,
    parallel: false,
    maxParallel: 1,
    enableEvalCritic: false,
  }, agent);
  return runner.runAll();
}

const tool = (i: number): ToolExecutionRecord => ({ tool: 'bash', input: { command: `step ${i}` }, output: 'ok', success: true, duration: 1, timestamp: Date.now() });

/** 慢 sendMessage：每 10ms 完成一次工具调用，直到被 cancelActiveRun 掐掉才 return。 */
function cancellableAgent(): { agent: AgentInterface; completed: () => number } {
  let cancelled = false;
  let completed = 0;
  const agent: AgentInterface = {
    sendMessage: async () => {
      const toolExecutions: ToolExecutionRecord[] = [];
      while (!cancelled) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        if (cancelled) break;
        toolExecutions.push(tool(++completed));
      }
      return { responses: ['partial'], toolExecutions, turnCount: toolExecutions.length, errors: [], permissionRequests: [] };
    },
    cancelActiveRun: async () => { cancelled = true; },
    reset: async () => undefined,
    getAgentInfo: () => ({ name: 'mock', model: 'mock', provider: 'mock' }),
  };
  return { agent, completed: () => completed };
}

describe('testRunner 超时轨迹保全（N-EVAL-TIMEOUT-K1-TRACE）', () => {
  it('首轮超时 ⇒ 并入被掐那一轮已完成的工具调用，主码仍是 timeout', async () => {
    const { agent, completed } = cancellableAgent();
    const summary = await runWith(agent, 80);
    const result = summary.results[0];
    expect(completed()).toBeGreaterThan(0);
    expect(result.toolExecutions).toHaveLength(completed());
    expect(result.responses).toEqual(['partial']);
    expect(result.turnCount).toBe(completed());
    expect(result.permissionRequests).toEqual([]);
    expect(result).toMatchObject({ status: 'failed', failureStage: 'timeout', killedByTimeout: true, timeoutTraceAvailable: true });
    expect(result.failure?.code).toBe('timeout');
  });

  it('follow-up 轮超时 ⇒ 前一轮 + 被掐轮都在，不重复计数', async () => {
    let calls = 0;
    const slow = cancellableAgent();
    const agent: AgentInterface = {
      ...slow.agent,
      sendMessage: async (prompt, options) => {
        calls++;
        if (calls === 1) return { responses: ['first'], toolExecutions: [tool(0)], turnCount: 1, errors: [] };
        return slow.agent.sendMessage(prompt, options);
      },
    };
    const summary = await runWith(agent, 80, true);
    const result = summary.results[0];
    expect(slow.completed()).toBeGreaterThan(0);
    expect(result.toolExecutions).toHaveLength(1 + slow.completed());
    expect(result.responses).toEqual(['first', 'partial']);
    expect(result).toMatchObject({ failureStage: 'timeout', timeoutTraceAvailable: true });
  });

  it('宽限期内等不到 ⇒ 退回现状（轨迹为空）并标 timeoutTraceAvailable=false', async () => {
    const summary = await runWith({
      sendMessage: () => new Promise(() => undefined),
      cancelActiveRun: async () => undefined,
      reset: async () => undefined,
      getAgentInfo: () => ({ name: 'mock', model: 'mock', provider: 'mock' }),
    }, 50);
    const result = summary.results[0];
    expect(result.toolExecutions).toEqual([]);
    expect(result.responses).toEqual([]);
    expect(result).toMatchObject({ status: 'failed', failureStage: 'timeout', killedByTimeout: true, timeoutTraceAvailable: false });
    expect(result.failure?.code).toBe('timeout');
  });

  // 「不白等 5s 宽限」由 fakeClosed.test.ts 超时归因用例（5s 预算、真常量）兜住；这里宽限被 mock 成 100ms，只核标记。
  it('adapter 不实现 cancelActiveRun ⇒ 直接标不可得', async () => {
    const summary = await runWith({
      sendMessage: () => new Promise(() => undefined),
      reset: async () => undefined,
      getAgentInfo: () => ({ name: 'mock', model: 'mock', provider: 'mock' }),
    }, 50);
    expect(summary.results[0]).toMatchObject({ failureStage: 'timeout', timeoutTraceAvailable: false });
  });
});
