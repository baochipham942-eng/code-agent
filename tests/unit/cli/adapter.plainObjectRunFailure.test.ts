// A thrown plain object must stay a failed CLI run with readable error text.
// The night-patrol exit=0 report is checked here before any product change.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent, Message } from '../../../src/shared/contract';
import type { CLIConfig } from '../../../src/cli/types';

vi.unmock('better-sqlite3');

const mocks = vi.hoisted(() => {
  const buildCLIConfig = vi.fn();
  const createAgentLoop = vi.fn();
  const getSessionManager = vi.fn();
  const getConfigService = vi.fn();
  const getSessionSkillService = vi.fn();
  const addSwarmEventListener = vi.fn().mockReturnValue(() => {});
  const resolveExplicitAgentOverride = vi.fn();

  return {
    buildCLIConfig,
    createAgentLoop,
    initializeCLIServices: vi.fn().mockResolvedValue(undefined),
    isCLIBareMode: vi.fn().mockReturnValue(false),
    getSessionManager,
    getConfigService,
    startCLIDurableRun: vi.fn().mockResolvedValue(null),
    terminalCLIDurableRun: vi.fn().mockResolvedValue(undefined),
    getSessionSkillService,
    addSwarmEventListener,
    resolveExplicitAgentOverride,
    retryOn: vi.fn(),
  };
});

vi.mock('../../../src/cli/bootstrap', () => ({
  buildCLIConfig: mocks.buildCLIConfig,
  createAgentLoop: mocks.createAgentLoop,
  initializeCLIServices: mocks.initializeCLIServices,
  isCLIBareMode: mocks.isCLIBareMode,
  getSessionManager: mocks.getSessionManager,
  getConfigService: mocks.getConfigService,
  startCLIDurableRun: mocks.startCLIDurableRun,
  terminalCLIDurableRun: mocks.terminalCLIDurableRun,
  whenCLIMcpReady: () => Promise.resolve(),
}));

vi.mock('../../../src/host/services/skills/sessionSkillService', () => ({
  getSessionSkillService: mocks.getSessionSkillService,
}));

vi.mock('../../../src/host/ipc/swarm.ipc', () => ({
  addSwarmEventListener: mocks.addSwarmEventListener,
}));

vi.mock('../../../src/cli/output', () => ({
  terminalOutput: {
    handleEvent: vi.fn(),
    handleSwarmEvent: vi.fn(),
    retrying: vi.fn(),
  },
  jsonOutput: {
    handleEvent: vi.fn(),
    handleSwarmEvent: vi.fn(),
  },
}));

vi.mock('../../../src/host/model/providers/retryStrategy', () => ({
  retryEvents: { on: mocks.retryOn },
}));

vi.mock('../../../src/host/services/infra/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock('../../../src/host/agent/metricsCollector', () => ({
  MetricsCollector: class {
    recordCompaction = vi.fn();
    recordError = vi.fn();
    toJSON = vi.fn().mockReturnValue('{"ok":true}');
    finalize = vi.fn().mockReturnValue({ sessionId: 'sess-1', turnCount: 1 });
    getMetrics = vi.fn().mockReturnValue({ inputTokens: 0, outputTokens: 0 });
  },
}));

vi.mock('../../../src/host/agent/explicitAgentOverride', () => ({
  resolveExplicitAgentOverride: mocks.resolveExplicitAgentOverride,
}));

import { CLIAgent } from '../../../src/cli/adapter';
import { resolveRunExitCode } from '../../../src/cli/exitCodes';

const baseConfig: CLIConfig = {
  workingDirectory: '/tmp/project',
  modelConfig: {
    provider: 'openai',
    model: 'test-model',
    apiKey: 'k',
    temperature: 0,
    maxTokens: 1024,
  },
  outputFormat: 'text',
  enablePlanning: false,
  debug: false,
};

const plainObjectFailure = { code: 'X', message: 'boom' };

function installThrowingLoop(): void {
  mocks.createAgentLoop.mockImplementation(() => ({
    cancel: vi.fn(),
    interrupt: vi.fn(),
    getHookManager: vi.fn(),
    run: vi.fn().mockRejectedValue(plainObjectFailure),
  }));
}

function installCompletingLoop(): void {
  mocks.createAgentLoop.mockImplementation(
    (_cfg: unknown, onEvent: (event: AgentEvent) => void) => ({
      cancel: vi.fn(),
      interrupt: vi.fn(),
      getHookManager: vi.fn(),
      run: vi.fn(async () => {
        onEvent({ type: 'agent_complete' } as AgentEvent);
      }),
    }),
  );
}

describe('CLIAgent plain-object run failure', () => {
  const stored: Message[] = [];

  beforeEach(() => {
    stored.length = 0;
    vi.clearAllMocks();
    mocks.buildCLIConfig.mockReturnValue({ ...baseConfig });
    mocks.getConfigService.mockReturnValue({
      getApiKey: vi.fn().mockReturnValue('resolved-key'),
    });
    mocks.getSessionSkillService.mockReturnValue({
      autoMountDefaultSkills: vi.fn(),
    });
    mocks.addSwarmEventListener.mockReturnValue(() => {});
    mocks.resolveExplicitAgentOverride.mockReturnValue(null);
    mocks.getSessionManager.mockReturnValue({
      getOrCreateCurrentSession: vi.fn().mockResolvedValue({ id: 'sess-1' }),
      getSession: vi.fn().mockResolvedValue({ id: 'sess-1', metadata: undefined }),
      addMessage: vi.fn(async (message: Message) => {
        stored.push(message);
      }),
      restoreSession: vi.fn(async (sessionId: string) => ({
        id: sessionId,
        messages: stored.map((message) => ({ ...message })),
      })),
      updateSession: vi.fn().mockResolvedValue(undefined),
    });
  });

  it('keeps success false, a readable error, and exit code 1 when the loop throws a plain object', async () => {
    installThrowingLoop();
    const agent = new CLIAgent();
    const result = await agent.run('draw a cat');

    expect(result.success).toBe(false);
    expect(resolveRunExitCode(result)).toBe(1);
    expect(result.error).toContain('boom');
    expect(result.error).not.toContain('[object Object]');
  });

  it('appends the next user message when the same session resumes after that failure', async () => {
    installThrowingLoop();
    const failed = new CLIAgent();
    const failedResult = await failed.run('first prompt');
    expect(failedResult.success).toBe(false);

    installCompletingLoop();
    const resumed = new CLIAgent();
    expect(await resumed.restoreSession('sess-1')).toBe(true);
    const followUp = await resumed.run('follow up');

    expect(followUp.success).toBe(true);
    expect(stored.map((message) => message.content)).toEqual(['first prompt', 'follow up']);
    const resumedMessages = mocks.createAgentLoop.mock.calls.at(-1)?.[2] as Message[];
    expect(resumedMessages.map((message) => message.content)).toEqual(['first prompt', 'follow up']);
  });
});
