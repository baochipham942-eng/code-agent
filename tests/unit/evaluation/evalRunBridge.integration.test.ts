import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseService } from '../../../src/host/services/core/databaseService';
import {
  EVAL_RUN_STAMP_KEYS,
  type EvalRunEvent,
} from '../../../src/shared/contract/evaluation';
import { EvalRunBridge } from '@internal-evaluation/host/evaluation/evalRunBridge';
import { inspectEvalEnvironment } from '@internal-evaluation/host/evaluation/evalEnvironment';
import { filterTestCases, loadAllTestSuites } from '../../../src/host/testing/testCaseLoader';
import { isRedlineCase } from '../../../src/host/testing/testCaseClassification';

const roots: string[] = [];
const previousDataDir = process.env.CODE_AGENT_DATA_DIR;
const previousAnswerDir = process.env.NEO_EVAL_ANSWERS_DIR;

async function waitFor(predicate: () => boolean, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for real eval child');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

afterEach(() => {
  if (previousDataDir === undefined) delete process.env.CODE_AGENT_DATA_DIR;
  else process.env.CODE_AGENT_DATA_DIR = previousDataDir;
  if (previousAnswerDir === undefined) delete process.env.NEO_EVAL_ANSWERS_DIR;
  else process.env.NEO_EVAL_ANSWERS_DIR = previousAnswerDir;
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('EvalRunBridge child-process integration', () => {
  it('starts the real entrypoint without a paid request, keeps the parent data file untouched, streams failure, and cleans child temp state', async () => {
    const sentinelRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-parent-sentinel-'));
    roots.push(sentinelRoot);
    const sentinelDb = path.join(sentinelRoot, 'code-agent.db');
    fs.writeFileSync(sentinelDb, 'parent-sentinel');
    const mtimeBefore = fs.statSync(sentinelDb).mtimeMs;
    process.env.CODE_AGENT_DATA_DIR = sentinelRoot;
    const answerRoot = path.join(sentinelRoot, 'private-eval');
    const answerPath = path.join(
      answerRoot,
      'answers',
      '.claude',
      'test-cases',
      '01-tool-tests.yaml',
    );
    fs.mkdirSync(path.dirname(answerPath), { recursive: true });
    fs.writeFileSync(answerPath, [
      'version: 1',
      'source: .claude/test-cases/01-tool-tests.yaml',
      'cases:',
      '  - id: bash-pwd',
      '    expect: { response_contains: [/] }',
      '',
    ].join('\n'));
    const coreCases = filterTestCases(
      await loadAllTestSuites(path.join(process.cwd(), '.claude', 'test-cases')),
      {},
    );
    const safety = coreCases.filter(isRedlineCase).map((testCase) => testCase.id);
    const heldIn = coreCases.filter((testCase) => !safety.includes(testCase.id)).map((testCase) => testCase.id);
    fs.writeFileSync(path.join(answerRoot, 'eval-splits.json'), JSON.stringify({
      version: 1,
      seed: 'bridge-hermetic',
      createdAt: '2026-09-02',
      heldIn,
      heldOut: [],
      control: [],
      safety,
    }));
    process.env.NEO_EVAL_ANSWERS_DIR = answerRoot;

    const database = {
      isReady: true,
      initialize: vi.fn(),
      insertExperiment: vi.fn(),
      insertExperimentCases: vi.fn(),
      updateExperimentSummary: vi.fn(),
    };
    const events: EvalRunEvent[] = [];
    let childTempRoot = '';
    let spawnedArgs: readonly string[] = [];
    const bridge = new EvalRunBridge({
      inspectEnvironment: () => inspectEvalEnvironment({ packaged: false, cwd: process.cwd() }),
      database: () => database as unknown as DatabaseService,
      resolveModel: () => ({
        provider: 'custom-json-events-error',
        model: 'no-paid-request',
        apiKey: 'test-key',
        temperature: 0,
        maxTokens: 32,
      }),
      publish: (_channel, event) => events.push(event as EvalRunEvent),
      spawnProcess: (command, args, options) => {
        spawnedArgs = args;
        childTempRoot = path.dirname((options.env as NodeJS.ProcessEnv).CODE_AGENT_EVAL_TEMP_ROOT!);
        return spawn(command, Array.from(args), options);
      },
    });

    const { runId } = await bridge.startRun({ scope: 'smoke', maxCases: 1, ids: ['bash-pwd'] });
    await waitFor(() => !bridge.subscribe(runId).running);

    expect(spawnedArgs).toEqual(expect.arrayContaining([
      expect.stringContaining('packages/internal/evaluation-center/scripts/eval-ci.ts'), '--real', '--json-events', '--data-dir',
      expect.any(String), '--run-id', runId,
    ]));
    expect(events.some((event) => event.type === 'error')).toBe(true);
    expect(events.some((event) => event.type === 'run_end' && event.exitCode === 2)).toBe(true);
    expect(database.insertExperiment).toHaveBeenCalledTimes(1);
    const persistedConfig = JSON.parse(database.insertExperiment.mock.calls[0]![0].config_json);
    for (const key of EVAL_RUN_STAMP_KEYS) expect(persistedConfig).toHaveProperty(key);
    expect(JSON.parse(database.updateExperimentSummary.mock.calls.at(-1)![1])).toMatchObject({
      completed: false,
      source: 'eval',
    });
    expect(fs.existsSync(childTempRoot)).toBe(false);
    expect(fs.readFileSync(sentinelDb, 'utf8')).toBe('parent-sentinel');
    expect(fs.statSync(sentinelDb).mtimeMs).toBe(mtimeBefore);
  }, 40_000);
});
