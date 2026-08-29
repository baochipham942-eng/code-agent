import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseService } from '../../../src/host/services/core/databaseService';
import type { EvalRunEvent } from '../../../src/shared/contract/evaluation';
import { EVAL_RUN_EVENT_SCHEMA_VERSION } from '../../../src/shared/contract/evaluation';
import { EvalRunBridge } from '../../../src/host/evaluation/evalRunBridge';

interface FakeDatabase {
  isReady: boolean;
  initialize: ReturnType<typeof vi.fn>;
  insertExperiment: ReturnType<typeof vi.fn>;
  insertExperimentCases: ReturnType<typeof vi.fn>;
  updateExperimentSummary: ReturnType<typeof vi.fn>;
}

const bridges: EvalRunBridge[] = [];

function fakeDatabase(): FakeDatabase {
  return {
    isReady: true,
    initialize: vi.fn(),
    insertExperiment: vi.fn(),
    insertExperimentCases: vi.fn(),
    updateExperimentSummary: vi.fn(),
  };
}

function environment() {
  const repositoryRoot = process.cwd();
  return {
    available: true,
    message: 'ready',
    repositoryRoot,
    entryPath: path.join(repositoryRoot, 'scripts', 'eval-ci.ts'),
    nodePath: process.execPath,
    tsxPath: path.join(repositoryRoot, 'node_modules', '.bin', 'tsx'),
    packaged: false,
    platform: process.platform,
    osJail: { enabled: true, available: true, active: true },
    git: { available: true, repository: true },
    proxy: {},
    failures: [],
  };
}

function model() {
  return {
    provider: 'openai' as const,
    model: 'test-model',
    apiKey: 'test-key',
    temperature: 0,
    maxTokens: 100,
  };
}

function eventScript(args: readonly string[], body: (runId: string) => EvalRunEvent[]): string {
  const runId = args[args.indexOf('--run-id') + 1];
  return body(runId).map((event) => `process.stdout.write(${JSON.stringify(`${JSON.stringify(event)}\n`)});`).join('\n');
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for bridge state');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function pidExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

function processGroupExists(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

afterEach(async () => {
  for (const bridge of bridges.splice(0)) {
    // Tests normally close every child themselves. This catches assertion failures
    // without leaving an evaluation process behind.
    const active = Reflect.get(bridge, 'runs') as Map<string, unknown>;
    for (const runId of active.keys()) await bridge.abortRun(runId, 'test cleanup');
  }
});

describe('EvalRunBridge', () => {
  it('streams start/case/end events and makes the host database the canonical writer', async () => {
    const db = fakeDatabase();
    const published: EvalRunEvent[] = [];
    let spawnedEnv: NodeJS.ProcessEnv | undefined;
    const bridge = new EvalRunBridge({
      inspectEnvironment: environment,
      database: () => db as unknown as DatabaseService,
      resolveModel: model,
      publish: (_channel, event) => published.push(event as EvalRunEvent),
      spawnProcess: (_command, args, options) => {
        spawnedEnv = options.env;
        const script = eventScript(args, (runId) => {
          const started = Date.now();
          return [
            {
              schemaVersion: EVAL_RUN_EVENT_SCHEMA_VERSION,
              type: 'run_start',
              ts: started,
              runId,
              plannedCaseIds: ['case-1'],
              config: {
                mode: 'real', model: 'test-model', provider: 'openai', scope: 'smoke',
                maxCases: 1, concurrency: 1, gitCommit: 'abc', testCaseDir: '/private/cases',
              },
            },
            {
              schemaVersion: EVAL_RUN_EVENT_SCHEMA_VERSION,
              type: 'case_end',
              ts: started + 1,
              runId,
              testId: 'case-1',
              status: 'passed',
              score: 1,
              durationMs: 5,
              responses: ['ok'],
              toolExecutions: [],
              errors: [],
              sessionId: 'eval-session-1',
            },
            {
              schemaVersion: EVAL_RUN_EVENT_SCHEMA_VERSION,
              type: 'run_end',
              ts: started + 2,
              runId,
              summary: {
                runId, startTime: started, endTime: started + 2, duration: 2,
                total: 1, passed: 1, failed: 0, skipped: 0, partial: 0,
                averageScore: 1, plannedCaseIds: ['case-1'], completed: true,
                notRun: 0, invalidCases: 0,
              },
              reportFiles: [],
              exitCode: 0,
              aborted: false,
            },
          ];
        });
        return spawn(process.execPath, ['-e', script], options) as ChildProcess;
      },
    });
    bridges.push(bridge);

    const { runId } = await bridge.startRun({ scope: 'smoke', maxCases: 1, ids: ['case-1'] });
    await waitFor(() => !bridge.subscribe(runId).running);

    expect(published.map((event) => event.type)).toEqual(['run_start', 'case_end', 'run_end']);
    expect(db.insertExperiment).toHaveBeenCalledTimes(1);
    expect(db.insertExperimentCases).toHaveBeenCalledTimes(1);
    expect(db.updateExperimentSummary).toHaveBeenCalledTimes(1);
    expect(JSON.parse(db.updateExperimentSummary.mock.calls[0][1])).toMatchObject({
      completed: true,
      source: 'eval',
    });
    expect(spawnedEnv).toMatchObject({
      CODE_AGENT_EVAL_BRIDGE: '1',
      OS_SANDBOX_ENABLED: 'true',
    });
  });

  it('kills an ignored-SIGTERM process tree, proves the group disappeared, and cleans temp files', async () => {
    const db = fakeDatabase();
    let childPid = 0;
    let tempRoot = '';
    const bridge = new EvalRunBridge({
      inspectEnvironment: environment,
      database: () => db as unknown as DatabaseService,
      resolveModel: model,
      publish: vi.fn(),
      spawnProcess: (_command, _args, options) => {
        const env = options.env as NodeJS.ProcessEnv;
        tempRoot = path.dirname(env.CODE_AGENT_EVAL_TEMP_ROOT!);
        const script = [
          "const {spawn}=require('node:child_process')",
          "spawn(process.execPath,['-e',\"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)\"],{stdio:'ignore'})",
          "process.on('SIGTERM',()=>{})",
          'setInterval(()=>{},1000)',
        ].join(';');
        const child = spawn(process.execPath, ['-e', script], options);
        childPid = child.pid!;
        return child;
      },
    });
    bridges.push(bridge);

    const { runId } = await bridge.startRun({ scope: 'smoke', maxCases: 1, ids: ['case-1'] });
    await new Promise((resolve) => setTimeout(resolve, 150));
    const result = await bridge.abortRun(runId, 'abort test');

    expect(result).toEqual({ runId, pid: childPid, terminated: true });
    expect(pidExists(childPid)).toBe(false);
    expect(processGroupExists(childPid)).toBe(false);
    expect(fs.existsSync(tempRoot)).toBe(false);
    expect(JSON.parse(db.updateExperimentSummary.mock.calls.at(-1)![1])).toMatchObject({
      completed: false,
      aborted: true,
    });
  }, 10_000);

  it('publishes an error and records an incomplete run when exit is nonzero without run_end', async () => {
    const db = fakeDatabase();
    const published: EvalRunEvent[] = [];
    const bridge = new EvalRunBridge({
      inspectEnvironment: environment,
      database: () => db as unknown as DatabaseService,
      resolveModel: model,
      publish: (_channel, event) => published.push(event as EvalRunEvent),
      spawnProcess: (_command, args, options) => {
        const script = `${eventScript(args, (runId) => [{
          schemaVersion: EVAL_RUN_EVENT_SCHEMA_VERSION,
          type: 'run_start',
          ts: Date.now(),
          runId,
          plannedCaseIds: ['case-1'],
          config: {
            mode: 'real', model: 'test-model', provider: 'openai', scope: 'smoke',
            maxCases: 1, concurrency: 1, gitCommit: 'abc', testCaseDir: '/private/cases',
          },
        }])}\nprocess.exitCode=1;`;
        return spawn(process.execPath, ['-e', script], options) as ChildProcess;
      },
    });
    bridges.push(bridge);

    const { runId } = await bridge.startRun({ scope: 'smoke', maxCases: 1, ids: ['case-1'] });
    await waitFor(() => !bridge.subscribe(runId).running);

    expect(published.at(-1)).toMatchObject({ type: 'error', runId });
    expect(JSON.parse(db.updateExperimentSummary.mock.calls.at(-1)![1])).toMatchObject({
      completed: false,
      notRun: 1,
    });
  });

  it('rejects mock/provider/key/cwd payloads before spawning', async () => {
    const spawnProcess = vi.fn();
    const bridge = new EvalRunBridge({
      inspectEnvironment: environment,
      database: () => fakeDatabase() as unknown as DatabaseService,
      resolveModel: model,
      spawnProcess,
      publish: vi.fn(),
    });
    bridges.push(bridge);

    await expect(bridge.startRun({ scope: 'smoke', maxCases: 1, mock: true })).rejects.toThrow(/mock/);
    await expect(bridge.startRun({ scope: 'smoke', maxCases: 1, provider: 'openai' })).rejects.toThrow(/provider/);
    await expect(bridge.startRun({ scope: 'smoke', maxCases: 1, apiKey: 'secret' })).rejects.toThrow(/apiKey/);
    await expect(bridge.startRun({ scope: 'smoke', maxCases: 1, workingDirectory: '/tmp' })).rejects.toThrow(/workingDirectory/);
    expect(spawnProcess).not.toHaveBeenCalled();
  });

  it('fails loudly on a protocol version mismatch', async () => {
    const db = fakeDatabase();
    const published: EvalRunEvent[] = [];
    const bridge = new EvalRunBridge({
      inspectEnvironment: environment,
      database: () => db as unknown as DatabaseService,
      resolveModel: model,
      publish: (_channel, event) => published.push(event as EvalRunEvent),
      spawnProcess: (_command, args, options) => {
        const runId = args[args.indexOf('--run-id') + 1];
        const line = JSON.stringify({ schemaVersion: 1, type: 'run_start', runId, ts: Date.now() });
        return spawn(process.execPath, ['-e', `console.log(${JSON.stringify(line)})`], options) as ChildProcess;
      },
    });
    bridges.push(bridge);

    const { runId } = await bridge.startRun({ scope: 'smoke', maxCases: 1 });
    await waitFor(() => !bridge.subscribe(runId).running);

    expect(published.some((event) => event.type === 'error' && event.error.includes('版本'))).toBe(true);
  });
});
