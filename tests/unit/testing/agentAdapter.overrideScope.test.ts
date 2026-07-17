import { beforeEach, describe, expect, it, vi } from 'vitest';
import { StandaloneAgentAdapter } from '../../../src/host/testing/agentAdapter';
import { getCompressionPipelineOverride } from '../../../src/host/context/compressionPipeline';
import {
  getScaffoldProfileOverride,
  getThinkingInjectionOverride,
} from '../../../src/host/agent/runtime/scaffoldProfile';

type OverrideSnapshot = {
  compressionPipeline: boolean | undefined;
  scaffoldProfile: boolean | undefined;
  thinkingInjection: boolean | undefined;
};

function readOverrides(): OverrideSnapshot {
  return {
    compressionPipeline: getCompressionPipelineOverride(),
    scaffoldProfile: getScaffoldProfileOverride(),
    thinkingInjection: getThinkingInjectionOverride(),
  };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

let runEntered = deferred();
let releaseRun = deferred();
let constructorOverrides: OverrideSnapshot[] = [];
let runOverrides: OverrideSnapshot[] = [];

vi.mock('../../../src/host/agent/agentLoop', () => ({
  AgentLoop: class {
    constructor(_config: unknown) {
      constructorOverrides.push(readOverrides());
    }

    async run(): Promise<void> {
      runOverrides.push(readOverrides());
      runEntered.resolve();
      await releaseRun.promise;
    }
  },
}));

vi.mock('../../../src/host/prompts/builder', () => ({
  SYSTEM_PROMPT: 'test system prompt',
}));

vi.mock('../../../src/host/tools/toolExecutor', () => ({
  ToolExecutor: class {},
}));

vi.mock('../../../src/host/telemetry', () => ({
  getTelemetryCollector: () => ({
    startSession: vi.fn(),
    endSession: vi.fn(),
    handleEvent: vi.fn(),
    createAdapter: vi.fn(() => ({})),
  }),
}));

vi.mock('../../../src/host/services/core/databaseService', () => ({
  getDatabase: () => ({ isReady: false }),
}));

beforeEach(() => {
  runEntered = deferred();
  releaseRun = deferred();
  constructorOverrides = [];
  runOverrides = [];
});

describe('StandaloneAgentAdapter harness override scope', () => {
  it('eval 持有三个 override 时，并发产线读取仍为默认值', async () => {
    const adapter = new StandaloneAgentAdapter({
      workingDirectory: '/tmp',
      modelConfig: { provider: 'mock', model: 'mock-model' },
      harness: {
        name: 'override-scope-test',
        compressionPipeline: false,
        scaffoldProfile: true,
        thinkingInjection: false,
      },
    });

    const evalRun = adapter.sendMessage('hold eval run');
    await runEntered.promise;
    const productionRead = readOverrides();
    releaseRun.resolve();
    const result = await evalRun;

    expect(result.errors).toEqual([]);
    expect(constructorOverrides).toEqual([{
      compressionPipeline: false,
      scaffoldProfile: true,
      thinkingInjection: false,
    }]);
    expect(runOverrides).toEqual(constructorOverrides);
    expect(productionRead).toEqual({
      compressionPipeline: undefined,
      scaffoldProfile: undefined,
      thinkingInjection: undefined,
    });
    expect(readOverrides()).toEqual(productionRead);
  });
});
