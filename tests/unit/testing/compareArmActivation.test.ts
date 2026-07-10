// ============================================================================
// A3 臂激活断言 — eval-ci --compare 报数前的准入 preflight
// ============================================================================
// maka #623 教训泛化：「开关开了 ≠ 链路真触发」。Neo 同族病史 4 次
// （ABComparator 零调用 / cache 字段就地丢弃 / manifest 生产恒断链 /
// 设计门 selector 空匹配）。本文件钉死三条契约：
//   1. 跑前：candidate 有效配置与 baseline 相同（含字段回落语义）→ 拒绝发车
//   2. 跑后：零 case / 全部 pair 被排除（无有效配对数据）→ 拒绝报数
//   3. 接线：eval-ci 的 --compare 路径真的调用了这两道断言（producer+consumer
//      同时存在——断言函数存在但没人调用 = 新的空跑臂）
// 每条断言都做过 mutation 自证（关臂/摘调用方必红），证据见 commit message。
// ============================================================================

import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtemp } from 'fs/promises';
import os from 'os';
import path from 'path';
import {
  runCompare,
  assertCompareArmsDistinct,
  assertCompareArmsActivated,
} from '../../../src/host/testing/comparator/runCompare';
import type { AgentInterface } from '../../../src/host/testing/testRunner';
import type { CompareConfiguration, TestCase, TestRunnerConfig } from '../../../src/host/testing/types';

vi.mock('../../../src/host/services/core/databaseService', () => ({
  getDatabase: () => ({
    insertExperiment: vi.fn(),
    insertExperimentCases: vi.fn(),
  }),
}));

const repoRoot = resolve(fileURLToPath(new URL('../../..', import.meta.url)));

const BASELINE: CompareConfiguration = { name: 'baseline', model: 'model-a', provider: 'mock' };

const CASES: TestCase[] = [
  { id: 'case-1', type: 'task', description: 'first', prompt: 'do one', expect: { response_contains: ['done'] } },
  { id: 'case-2', type: 'task', description: 'second', prompt: 'do two', expect: { response_contains: ['done'] } },
];

async function runnerConfig(): Promise<TestRunnerConfig> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'code-agent-arm-activation-'));
  return {
    testCaseDir: root,
    resultsDir: path.join(root, 'results'),
    workingDirectory: root,
    defaultTimeout: 1000,
    stopOnFailure: false,
    verbose: false,
    parallel: false,
    maxParallel: 1,
    enableEvalCritic: false,
  };
}

describe('assertCompareArmsDistinct（跑前：对照臂必须有区分特征）', () => {
  it('candidate 与 baseline 显式相同（model/provider 一致、无其他差异）→ 拒绝', () => {
    const candidate: CompareConfiguration = { name: 'candidate', model: 'model-a', provider: 'mock' };
    expect(() => assertCompareArmsDistinct(BASELINE, candidate)).toThrow(/compare-arm-activation/);
  });

  it('candidate 只有 name、全部字段回落到 baseline（makeAgent 回落语义）→ 同样拒绝', () => {
    // 病根形态：candidate YAML 只写了个名字，makeAgent 里 config.model || resolvedModel
    // 全部回落 → 实际跑的是 baseline vs baseline，但字段层面 undefined ≠ 'model-a'
    const candidate: CompareConfiguration = { name: 'my-experiment' };
    expect(() => assertCompareArmsDistinct(BASELINE, candidate)).toThrow(/compare-arm-activation/);
  });

  it('candidate 带真实差异（systemPrompt）→ 放行', () => {
    const candidate: CompareConfiguration = { name: 'candidate', systemPrompt: 'be better' };
    expect(() => assertCompareArmsDistinct(BASELINE, candidate)).not.toThrow();
  });

  it('candidate 换模型 → 放行', () => {
    const candidate: CompareConfiguration = { name: 'candidate', model: 'model-b' };
    expect(() => assertCompareArmsDistinct(BASELINE, candidate)).not.toThrow();
  });
});

describe('assertCompareArmsActivated（跑后：必须有有效配对数据才准报数）', () => {
  const CANDIDATE: CompareConfiguration = { name: 'candidate', model: 'model-a', provider: 'mock', systemPrompt: 'variant' };

  it('全部 case 被 skip（零 case 进入对比）→ 拒绝报数', async () => {
    const allSkip: TestCase[] = CASES.map((c) => ({ ...c, skip: true }));
    const makeAgent = (): AgentInterface => ({
      sendMessage: async () => ({ responses: ['done'], toolExecutions: [], turnCount: 1, errors: [] }),
      reset: vi.fn(async () => undefined),
      getAgentInfo: () => ({ name: 'mock', model: 'm', provider: 'p' }),
    });

    const result = await runCompare({
      testCases: allSkip, baseline: BASELINE, candidate: CANDIDATE,
      makeAgent, runnerConfig: await runnerConfig(),
    });
    expect(() => assertCompareArmsActivated(result)).toThrow(/没有任何 case/);
  });

  it('全部 pair 因一侧零产出被排除（MiMo 401 形态）→ 拒绝报数并带排除原因', async () => {
    // candidate 臂结构性死亡：全部调用零产出带错误 → 每个 pair 都被 WP1-3b 排除，
    // totalCases=0。修复前 eval-ci 会照常写出「Tie 0-0」报告并绿灯退出。
    const makeAgent = (config: CompareConfiguration): AgentInterface => ({
      sendMessage: async () => {
        if (config.name === 'candidate') {
          return { responses: [], toolExecutions: [], turnCount: 0, errors: ['Invalid API Key'] };
        }
        return { responses: ['done, all good'], toolExecutions: [], turnCount: 1, errors: [] };
      },
      reset: vi.fn(async () => undefined),
      getAgentInfo: () => ({ name: 'mock', model: 'm', provider: 'p' }),
    });

    const result = await runCompare({
      testCases: CASES, baseline: BASELINE, candidate: CANDIDATE,
      makeAgent, runnerConfig: await runnerConfig(),
    });
    expect(result.summary.totalCases).toBe(0); // 前提成立：全排除
    expect(() => assertCompareArmsActivated(result)).toThrow(/臂未激活/);
    expect(() => assertCompareArmsActivated(result)).toThrow(/Invalid API Key/);
  });

  it('健康路径（双臂都真跑成）→ 放行且不误伤', async () => {
    const makeAgent = (config: CompareConfiguration): AgentInterface => ({
      sendMessage: async () => {
        if (config.name === 'candidate') {
          return {
            responses: ['done. ' + 'detailed work. '.repeat(30)],
            toolExecutions: [{ tool: 'bash', input: {}, output: 'ok', success: true, duration: 5, timestamp: 1 }],
            turnCount: 2,
            errors: [],
          };
        }
        return { responses: ['done'], toolExecutions: [], turnCount: 1, errors: [] };
      },
      reset: vi.fn(async () => undefined),
      getAgentInfo: () => ({ name: 'mock', model: 'm', provider: 'p' }),
    });

    const result = await runCompare({
      testCases: CASES, baseline: BASELINE, candidate: CANDIDATE,
      makeAgent, runnerConfig: await runnerConfig(),
    });
    expect(result.summary.totalCases).toBe(2);
    expect(() => assertCompareArmsActivated(result)).not.toThrow();
  });
});

describe('接线契约：eval-ci --compare 路径真的调用了两道断言', () => {
  it('scripts/eval-ci.ts 里 producer（断言函数导入）与 consumer（调用点）同时存在', () => {
    const evalCiSrc = readFileSync(resolve(repoRoot, 'scripts/eval-ci.ts'), 'utf8');
    // 跑前断言调用点（非 import 行——必须是真调用）
    expect(evalCiSrc).toMatch(/assertCompareArmsDistinct\(baseline, candidate\)/);
    // 跑后断言调用点，且必须出现在报数（generateComparisonConsole）之前
    const activatedAt = evalCiSrc.indexOf('assertCompareArmsActivated(result)');
    const reportAt = evalCiSrc.indexOf('generateComparisonConsole(result)');
    expect(activatedAt).toBeGreaterThan(-1);
    expect(reportAt).toBeGreaterThan(-1);
    expect(activatedAt).toBeLessThan(reportAt);
  });
});
