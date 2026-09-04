import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { DatabaseService } from '../../../src/host/services/core/databaseService';
import { EVAL_RUN_EVENT_SCHEMA_VERSION, UNKNOWN_EVAL_RUN_STAMP } from '../../../src/shared/contract/evaluation';
import { EvalRunBridge } from '@internal-evaluation/host/evaluation/evalRunBridge';
import {
  describeEvalCompareDiff,
  validateEvalCompareArm,
} from '@internal-evaluation/host/evaluation/evalCompareRequest';

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('timeout');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('compare request through EvalRunBridge', () => {
  it('差异带忽略仅用于展示的 harness 名称', () => {
    const baseline = { name: 'production', harness: { name: 'production', contextCompression: true } };
    const candidate = { name: 'candidate', harness: { name: 'candidate', contextCompression: true }, systemPrompt: 'new' };
    expect(describeEvalCompareDiff(baseline, candidate)).toEqual(['systemPrompt: sys-v45 → candidate']);
  });
  it('「子代理」维度的差异是一句人话，不是 JSON', () => {
    const baseline = { name: 'production', orchestration: { allowSwarm: true } };
    expect(describeEvalCompareDiff(baseline, {
      name: 'candidate', orchestration: { allowSwarm: false, spawnMaxDepth: 0 },
    })).toEqual(['子代理：编排引导开，最深 3 层（默认） → 编排引导关，一层都不扇出']);
    expect(describeEvalCompareDiff(baseline, {
      name: 'candidate', orchestration: { allowSwarm: true, spawnMaxDepth: 2 },
    })).toEqual(['子代理：编排引导开，最深 3 层（默认） → 编排引导开，最深 2 层']);
    // 两臂编排一致时不该冒出一行噪音
    expect(describeEvalCompareDiff(baseline, { name: 'candidate', systemPrompt: 'new' }))
      .toEqual(['systemPrompt: sys-v45 → candidate']);
  });

  it('spawnMaxDepth 非法值给的是人话，不是 schema 报错', () => {
    for (const bad of [-1, 1.5, 99, '2']) {
      expect(() => validateEvalCompareArm({ name: 'c', orchestration: { spawnMaxDepth: bad } }))
        .toThrow(/子代理最深层数要填 0 到 5 之间的整数（0 = 不扇出）。/);
    }
    expect(validateEvalCompareArm({ name: 'c', orchestration: { allowSwarm: true, spawnMaxDepth: 0 } }))
      .toMatchObject({ orchestration: { allowSwarm: true, spawnMaxDepth: 0 } });
    // orchestration 现在是被消费字段，不能再被当成未知字段拒掉
    expect(() => validateEvalCompareArm({ name: 'c', orchestration: { allowSwarm: true } })).not.toThrow();
  });

  it('T1：写 candidate YAML，透传 --compare + --json-events，并允许显式 mock 管线自检', async () => {
    let argsSeen: readonly string[] = [];
    let yamlSeen = '';
    const db = {
      isReady: true, initialize: vi.fn(), insertExperiment: vi.fn(), insertExperimentCases: vi.fn(), updateExperimentSummary: vi.fn(),
    };
    const bridge = new EvalRunBridge({
      inspectEnvironment: () => ({
        available: true, message: 'ready', repositoryRoot: process.cwd(), entryPath: 'eval-ci.ts', nodePath: process.execPath,
        tsxPath: 'tsx', packaged: false, platform: process.platform, osJail: { enabled: true, available: true, active: true },
        git: { available: true, repository: true }, proxy: {}, failures: [],
      }),
      database: () => db as unknown as DatabaseService,
      resolveModel: () => ({ provider: 'openai', model: 'm', apiKey: '', temperature: 0, maxTokens: 1 }),
      publish: vi.fn(),
      spawnProcess: (_command, args, options) => {
        argsSeen = args;
        const comparePath = args[args.indexOf('--compare') + 1];
        yamlSeen = fs.readFileSync(comparePath, 'utf8');
        const runId = args[args.indexOf('--run-id') + 1];
        const started = Date.now();
        const compare = {
          baseline: { name: 'production', model: 'm', provider: 'openai' },
          candidate: { name: 'candidate', systemPrompt: 'candidate prompt' },
          diff: ['systemPrompt: sys-v45 → candidate'],
        };
        const events = [
          { schemaVersion: EVAL_RUN_EVENT_SCHEMA_VERSION, type: 'run_start', ts: started, runId, plannedCaseIds: [], config: {
            ...UNKNOWN_EVAL_RUN_STAMP, mode: 'mock', model: 'm', provider: 'openai', scope: 'smoke', maxCases: 1,
            concurrency: 1, compare, gitCommit: 'abc', testCaseDir: 'cases',
          } },
          { schemaVersion: EVAL_RUN_EVENT_SCHEMA_VERSION, type: 'run_end', ts: started + 1, runId, summary: {
            runId, startTime: started, endTime: started + 1, duration: 1, total: 0, passed: 0, failed: 0,
            skipped: 0, partial: 0, averageScore: 0, plannedCaseIds: [], completed: true, notRun: 0, invalidCases: 0,
          }, reportFiles: [], exitCode: 0, aborted: false },
        ];
        const script = events.map((event) => `console.log(${JSON.stringify(JSON.stringify(event))})`).join(';');
        return spawn(process.execPath, ['-e', script], options) as ChildProcess;
      },
    });
    const { runId } = await bridge.startRun({
      scope: 'smoke', maxCases: 1, mode: 'mock', compare: { candidate: { name: 'candidate', systemPrompt: 'candidate prompt' } },
    });
    await waitFor(() => !bridge.subscribe(runId).running);

    expect(argsSeen).toEqual(expect.arrayContaining(['--json-events', '--force', '--compare']));
    expect(argsSeen).not.toContain('--real');
    expect(yamlSeen).toContain('systemPrompt: candidate prompt');
    expect(db.insertExperiment.mock.calls[0][0]).toMatchObject({ source: 'compare' });
  });

  it('在 spawn 前拒绝密钥/未知字段和两组相同', async () => {
    const spawnProcess = vi.fn();
    const bridge = new EvalRunBridge({
      inspectEnvironment: () => ({
        available: true, message: 'ready', repositoryRoot: path.resolve('.'), entryPath: 'eval-ci.ts', nodePath: process.execPath,
        tsxPath: 'tsx', packaged: false, platform: process.platform, osJail: { enabled: true, available: true, active: true },
        git: { available: true, repository: true }, proxy: {}, failures: [],
      }),
      database: () => ({ isReady: true } as unknown as DatabaseService),
      resolveModel: () => ({ provider: 'openai', model: 'm', apiKey: 'key', temperature: 0, maxTokens: 1 }),
      spawnProcess,
      publish: vi.fn(),
    });
    await expect(bridge.startRun({ scope: 'smoke', maxCases: 1, compare: { candidate: { name: 'c', apiKey: 'secret' } } }))
      .rejects.toThrow(/未知字段/);
    await expect(bridge.startRun({ scope: 'smoke', maxCases: 1, compare: { candidate: { name: 'c' } } }))
      .rejects.toThrow(/两组一样/);
    expect(spawnProcess).not.toHaveBeenCalled();
  });
});
