// ============================================================================
// N-EVAL-L3-HARNESS：题超时必须真的掐掉在跑的 run
// ============================================================================
// withTimeout 只是赛跑：超时题的 loop/工具会活到下一题（工作目录已清 ⇒ ENOENT ⇒
// 模型转去 find / 全盘搜，09-02 L3 首程 8 红里 7 红是它）。runner 在 timeout 分支
// 调 agent.cancelActiveRun；不实现的 adapter 维持旧行为。
// ============================================================================
import { describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import { TestRunner, type AgentInterface } from '../../../src/host/testing/testRunner';

vi.mock('../../../src/host/services/core/databaseService', () => ({
  getDatabase: () => ({ insertExperiment: vi.fn(), insertExperimentCases: vi.fn() }),
}));

const SUITE_YAML = [
  'name: timeout-cancel',
  'cases:',
  '  - id: slow-case',
  '    type: task',
  '    description: hangs past the case budget',
  '    prompt: say ok',
  '    expect:',
  '      response_contains: [ok]',
  '',
].join('\n');

async function runWith(agent: AgentInterface, timeout: number) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'code-agent-timeout-cancel-'));
  const casesDir = path.join(root, 'cases');
  await mkdir(casesDir, { recursive: true });
  await writeFile(path.join(casesDir, 'suite.yaml'), SUITE_YAML);
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

const hangingSend: AgentInterface['sendMessage'] = async () => {
  await new Promise((resolve) => setTimeout(resolve, 400));
  return { responses: ['ok'], toolExecutions: [], turnCount: 1, errors: [] };
};

describe('testRunner 超时掐 run（N-EVAL-L3-HARNESS）', () => {
  it('题超时 ⇒ 调 cancelActiveRun 一次，且结果仍是 timeout 能力失败', async () => {
    const cancelActiveRun = vi.fn(async () => undefined);
    const summary = await runWith({
      sendMessage: hangingSend,
      cancelActiveRun,
      reset: async () => undefined,
      getAgentInfo: () => ({ name: 'mock', model: 'mock', provider: 'mock' }),
    }, 50);
    expect(cancelActiveRun).toHaveBeenCalledTimes(1);
    expect(summary.results[0]).toMatchObject({ status: 'failed', failureStage: 'timeout', killedByTimeout: true });
  });

  it('正常完成 ⇒ 不调 cancelActiveRun', async () => {
    const cancelActiveRun = vi.fn(async () => undefined);
    const summary = await runWith({
      sendMessage: async () => ({ responses: ['ok'], toolExecutions: [], turnCount: 1, errors: [] }),
      cancelActiveRun,
      reset: async () => undefined,
      getAgentInfo: () => ({ name: 'mock', model: 'mock', provider: 'mock' }),
    }, 1000);
    expect(cancelActiveRun).not.toHaveBeenCalled();
    expect(summary.results[0].status).toBe('passed');
  });

  it('cancelActiveRun 抛错不改变超时判定（只告警）', async () => {
    const summary = await runWith({
      sendMessage: hangingSend,
      cancelActiveRun: async () => { throw new Error('cancel boom'); },
      reset: async () => undefined,
      getAgentInfo: () => ({ name: 'mock', model: 'mock', provider: 'mock' }),
    }, 50);
    expect(summary.results[0]).toMatchObject({ status: 'failed', failureStage: 'timeout' });
  });
});
