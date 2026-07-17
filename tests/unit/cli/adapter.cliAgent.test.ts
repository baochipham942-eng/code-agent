// ============================================================================
// CLIAgent (adapter.ts) — run lifecycle, event fan-out, cancel, session helpers
// ============================================================================

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent, Message } from '../../../src/shared/contract';
import type { CLIConfig } from '../../../src/cli/types';

const mocks = vi.hoisted(() => {
  const buildCLIConfig = vi.fn();
  const createAgentLoop = vi.fn();
  const initializeCLIServices = vi.fn().mockResolvedValue(undefined);
  const getSessionManager = vi.fn();
  const getConfigService = vi.fn();
  const getSessionSkillService = vi.fn();
  const addSwarmEventListener = vi.fn().mockReturnValue(() => {});
  const terminalHandleEvent = vi.fn();
  const terminalHandleSwarm = vi.fn();
  const terminalRetrying = vi.fn();
  const jsonHandleEvent = vi.fn();
  const jsonHandleSwarm = vi.fn();
  const retryOn = vi.fn();

  return {
    buildCLIConfig,
    createAgentLoop,
    initializeCLIServices,
    getSessionManager,
    getConfigService,
    getSessionSkillService,
    addSwarmEventListener,
    terminalHandleEvent,
    terminalHandleSwarm,
    terminalRetrying,
    jsonHandleEvent,
    jsonHandleSwarm,
    retryOn,
  };
});

vi.mock('../../../src/cli/bootstrap', () => ({
  buildCLIConfig: mocks.buildCLIConfig,
  createAgentLoop: mocks.createAgentLoop,
  initializeCLIServices: mocks.initializeCLIServices,
  getSessionManager: mocks.getSessionManager,
  getConfigService: mocks.getConfigService,
}));

vi.mock('../../../src/host/services/skills/sessionSkillService', () => ({
  getSessionSkillService: mocks.getSessionSkillService,
}));

vi.mock('../../../src/host/ipc/swarm.ipc', () => ({
  addSwarmEventListener: mocks.addSwarmEventListener,
}));

vi.mock('../../../src/cli/output', () => ({
  terminalOutput: {
    handleEvent: mocks.terminalHandleEvent,
    handleSwarmEvent: mocks.terminalHandleSwarm,
    retrying: mocks.terminalRetrying,
  },
  jsonOutput: {
    handleEvent: mocks.jsonHandleEvent,
    handleSwarmEvent: mocks.jsonHandleSwarm,
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
  },
}));

import { CLIAgent, createCLIAgent } from '../../../src/cli/adapter';

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

function makeSessionManager(overrides: Record<string, unknown> = {}) {
  return {
    getOrCreateCurrentSession: vi.fn().mockResolvedValue({ id: 'sess-1' }),
    addMessage: vi.fn().mockResolvedValue(undefined),
    restoreSession: vi.fn(),
    updateSession: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

type LoopCtl = {
  onEvent: (e: AgentEvent) => void;
  cancel: ReturnType<typeof vi.fn>;
  interrupt: ReturnType<typeof vi.fn>;
  getHookManager: ReturnType<typeof vi.fn>;
  run: ReturnType<typeof vi.fn>;
};

function installLoop(impl?: (ctl: LoopCtl) => Promise<void>): LoopCtl {
  const ctl: LoopCtl = {
    onEvent: () => {},
    cancel: vi.fn(),
    interrupt: vi.fn(),
    getHookManager: vi.fn().mockReturnValue({ hooks: true }),
    run: vi.fn(),
  };

  mocks.createAgentLoop.mockImplementation(
    (_cfg: unknown, onEvent: (e: AgentEvent) => void) => {
      ctl.onEvent = onEvent;
      ctl.run = vi.fn(async () => {
        if (impl) await impl(ctl);
      });
      return {
        cancel: ctl.cancel,
        interrupt: ctl.interrupt,
        getHookManager: ctl.getHookManager,
        run: ctl.run,
      };
    },
  );

  return ctl;
}

describe('CLIAgent', () => {
  let sessionManager: ReturnType<typeof makeSessionManager>;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.buildCLIConfig.mockReturnValue({ ...baseConfig });
    sessionManager = makeSessionManager();
    mocks.getSessionManager.mockReturnValue(sessionManager);
    mocks.getSessionSkillService.mockReturnValue({
      autoMountDefaultSkills: vi.fn(),
    });
    mocks.getConfigService.mockReturnValue({
      getApiKey: vi.fn().mockReturnValue('resolved-key'),
    });
    mocks.addSwarmEventListener.mockReturnValue(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('createCLIAgent initializes services then returns CLIAgent', async () => {
    const agent = await createCLIAgent({ project: '/tmp/p' });
    expect(mocks.initializeCLIServices).toHaveBeenCalled();
    expect(agent).toBeInstanceOf(CLIAgent);
  });

  it('initSession creates session and auto-mounts default skills', async () => {
    const agent = new CLIAgent();
    const id = await agent.initSession();
    expect(id).toBe('sess-1');
    expect(agent.getSessionId()).toBe('sess-1');
    expect(mocks.getSessionSkillService().autoMountDefaultSkills).toHaveBeenCalledWith('sess-1');
  });

  it('run happy path: agent_complete finishes success with tools and content', async () => {
    installLoop(async (ctl) => {
      ctl.onEvent({
        type: 'tool_call_start',
        data: { id: 't1', name: 'Read', arguments: { path: 'a.ts' } },
      } as AgentEvent);
      ctl.onEvent({
        type: 'stream_chunk',
        data: { content: 'hello ' },
      } as AgentEvent);
      ctl.onEvent({
        type: 'stream_chunk',
        data: { content: 'world' },
      } as AgentEvent);
      ctl.onEvent({ type: 'agent_complete' } as AgentEvent);
    });

    const agent = new CLIAgent();
    const result = await agent.run('say hi');

    expect(result.success).toBe(true);
    expect(result.output).toBe('hello world');
    expect(result.toolsUsed).toEqual(['Read']);
    expect(typeof result.duration).toBe('number');
    expect(agent.getIsRunning()).toBe(false);
    expect(mocks.terminalHandleEvent).toHaveBeenCalled();
    expect(sessionManager.addMessage).toHaveBeenCalledWith(
      expect.objectContaining({ role: 'user', content: 'say hi' }),
    );
  });

  it('error event before agent_complete marks run failed and keeps error message', async () => {
    installLoop(async (ctl) => {
      ctl.onEvent({
        type: 'error',
        data: { message: 'model 500' },
      } as AgentEvent);
      ctl.onEvent({ type: 'agent_complete' } as AgentEvent);
    });

    const agent = new CLIAgent();
    const result = await agent.run('x');
    expect(result.success).toBe(false);
    expect(result.error).toBe('model 500');
  });

  it('agentLoop.run rejection finishes with failure', async () => {
    mocks.createAgentLoop.mockImplementation(() => ({
      cancel: vi.fn(),
      interrupt: vi.fn(),
      getHookManager: vi.fn(),
      run: vi.fn().mockRejectedValue(new Error('loop boom')),
    }));

    const agent = new CLIAgent();
    const result = await agent.run('x');
    expect(result.success).toBe(false);
    expect(result.error).toBe('loop boom');
    expect(agent.getIsRunning()).toBe(false);
  });

  it('cancel delegates to currentAgentLoop when running', async () => {
    let resolveHang: (() => void) | undefined;
    const hang = new Promise<void>((r) => {
      resolveHang = r;
    });
    let loopRunStarted!: () => void;
    const loopStarted = new Promise<void>((r) => {
      loopRunStarted = r;
    });

    const cancel = vi.fn();
    mocks.createAgentLoop.mockImplementation((_c: unknown, onEvent: (e: AgentEvent) => void) => ({
      cancel,
      interrupt: vi.fn(),
      getHookManager: vi.fn(),
      run: vi.fn(async () => {
        loopRunStarted();
        await hang;
        onEvent({ type: 'agent_complete' } as AgentEvent);
      }),
    }));

    const agent = new CLIAgent();
    const p = agent.run('long');
    await loopStarted;
    expect(agent.getIsRunning()).toBe(true);

    agent.cancel();
    expect(cancel).toHaveBeenCalled();

    resolveHang?.();
    await p;
  });

  it('setEventObserver receives every agent event', async () => {
    const seen: string[] = [];
    installLoop(async (ctl) => {
      ctl.onEvent({ type: 'turn_start', data: { iteration: 1 } } as AgentEvent);
      ctl.onEvent({ type: 'agent_complete' } as AgentEvent);
    });

    const agent = new CLIAgent();
    agent.setEventObserver((e) => seen.push(e.type));
    await agent.run('obs');
    expect(seen).toEqual(['turn_start', 'agent_complete']);
  });

  it('stream-json output writes JSONL for tool/text/done and maps agent_dispatch', async () => {
    mocks.buildCLIConfig.mockReturnValue({
      ...baseConfig,
      outputFormat: 'stream-json' as const,
    });

    const lines: string[] = [];
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => {
      lines.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);

    installLoop(async (ctl) => {
      ctl.onEvent({
        type: 'stream_chunk',
        data: { content: 'chunk' },
      } as AgentEvent);
      ctl.onEvent({
        type: 'tool_call_start',
        data: {
          id: 'call-spawn',
          name: 'spawn_agent',
          arguments: { role: 'explore', task: 'scan' },
        },
      } as AgentEvent);
      ctl.onEvent({
        type: 'tool_call_end',
        data: { toolCallId: 'call-spawn', output: 'found', success: true },
      } as AgentEvent);
      ctl.onEvent({
        type: 'tool_call_start',
        data: { id: 'call-read', name: 'Read', arguments: { path: 'a' } },
      } as AgentEvent);
      ctl.onEvent({
        type: 'tool_call_end',
        data: { toolCallId: 'call-read', output: 'body', success: true },
      } as AgentEvent);
      ctl.onEvent({ type: 'agent_complete' } as AgentEvent);
    });

    const agent = new CLIAgent();
    await agent.run('jsonl');
    writeSpy.mockRestore();

    const parsed = lines
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { type: string; content?: unknown });

    expect(parsed.some((p) => p.type === 'text' && p.content === 'chunk')).toBe(true);
    expect(parsed.some((p) => p.type === 'agent_dispatch')).toBe(true);
    expect(parsed.some((p) => p.type === 'agent_result')).toBe(true);
    expect(parsed.some((p) => p.type === 'tool_start')).toBe(true);
    expect(parsed.some((p) => p.type === 'tool_result')).toBe(true);
    expect(parsed.some((p) => p.type === 'done')).toBe(true);
    // stream-json path should NOT use terminal handler for those events
    expect(mocks.terminalHandleEvent).not.toHaveBeenCalled();
  });

  it('json outputFormat routes events to jsonOutput', async () => {
    mocks.buildCLIConfig.mockReturnValue({
      ...baseConfig,
      outputFormat: 'json' as const,
    });

    installLoop(async (ctl) => {
      ctl.onEvent({ type: 'turn_start', data: {} } as AgentEvent);
      ctl.onEvent({ type: 'agent_complete' } as AgentEvent);
    });

    const agent = new CLIAgent();
    await agent.run('j');
    expect(mocks.jsonHandleEvent).toHaveBeenCalled();
    expect(mocks.terminalHandleEvent).not.toHaveBeenCalled();
  });

  it('accumulates real tokens from stream_usage and model_response', async () => {
    installLoop(async (ctl) => {
      ctl.onEvent({
        type: 'stream_usage',
        data: { inputTokens: 10, outputTokens: 5 },
      } as AgentEvent);
      ctl.onEvent({
        type: 'model_response',
        data: { inputTokens: 3, outputTokens: 2 },
      } as AgentEvent);
      ctl.onEvent({ type: 'agent_complete' } as AgentEvent);
    });

    const agent = new CLIAgent();
    await agent.run('tokens');
    expect(agent.getTokenUsage()).toEqual({ inputTokens: 13, outputTokens: 7 });
    expect(agent.getCostInfo()).toEqual(
      expect.objectContaining({
        inputTokens: 13,
        outputTokens: 7,
        model: 'test-model',
        provider: 'openai',
      }),
    );
  });

  it('setModel updates provider/model and resolves api key from config service', () => {
    const agent = new CLIAgent();
    agent.setModel('deepseek', 'deepseek-chat');
    expect(agent.getConfig().modelConfig.provider).toBe('deepseek');
    expect(agent.getConfig().modelConfig.model).toBe('deepseek-chat');
    expect(agent.getConfig().modelConfig.apiKey).toBe('resolved-key');
  });

  it('setModel keeps existing key when config service throws', () => {
    mocks.getConfigService.mockImplementation(() => {
      throw new Error('not ready');
    });
    const agent = new CLIAgent();
    const before = agent.getConfig().modelConfig.apiKey;
    agent.setModel('openai', 'gpt-x');
    expect(agent.getConfig().modelConfig.apiKey).toBe(before);
    expect(agent.getConfig().modelConfig.model).toBe('gpt-x');
  });

  it('injectContext pushes system message; clearHistory wipes messages and session', async () => {
    const agent = new CLIAgent();
    agent.injectContext('sys ctx');
    expect(agent.getHistory()).toEqual([
      expect.objectContaining({ role: 'system', content: 'sys ctx' }),
    ]);

    // run would also push user — but clear first
    await agent.initSession();
    expect(agent.getSessionId()).toBe('sess-1');
    agent.clearHistory();
    expect(agent.getHistory()).toEqual([]);
    expect(agent.getSessionId()).toBeNull();
  });

  it('restoreSession loads messages and prLink; returns false on miss', async () => {
    sessionManager.restoreSession.mockResolvedValueOnce({
      id: 'restored',
      messages: [{ id: 'm1', role: 'user', content: 'hi', timestamp: 1 }] as Message[],
      prLink: { owner: 'o', repo: 'r', number: 1, linkedAt: 100 },
    });

    const agent = new CLIAgent();
    expect(await agent.restoreSession('restored')).toBe(true);
    expect(agent.getSessionId()).toBe('restored');
    expect(agent.getHistory()).toHaveLength(1);
    expect(agent.getPRLink()).toEqual(
      expect.objectContaining({ owner: 'o', number: 1 }),
    );

    sessionManager.restoreSession.mockResolvedValueOnce(null);
    expect(await agent.restoreSession('missing')).toBe(false);
  });

  it('setPRLink updates local + session when session exists', async () => {
    const agent = new CLIAgent();
    await agent.initSession();
    agent.setPRLink({ owner: 'a', repo: 'b', number: 9, linkedAt: 200 });
    expect(agent.getPRLink()?.number).toBe(9);
    expect(sessionManager.updateSession).toHaveBeenCalledWith(
      'sess-1',
      expect.objectContaining({ prLink: expect.objectContaining({ number: 9 }) }),
    );
  });

  it('getHookManager prefers live loop, falls back to last completed', async () => {
    const liveHooks = { live: true };
    const pastHooks = { past: true };

    mocks.createAgentLoop.mockImplementation((_c: unknown, onEvent: (e: AgentEvent) => void) => ({
      cancel: vi.fn(),
      interrupt: vi.fn(),
      getHookManager: vi.fn().mockReturnValue(liveHooks),
      run: vi.fn(async () => {
        // during run, live hooks available
        onEvent({ type: 'agent_complete' } as AgentEvent);
      }),
    }));

    const agent = new CLIAgent();
    // before any run
    expect(agent.getHookManager()).toBeNull();

    const p = agent.run('h');
    // mid-flight would see live — after complete, lastHookManager kept
    await p;
    expect(agent.getHookManager()).toEqual(liveHooks);

    // second run with different hooks object → after complete still last
    mocks.createAgentLoop.mockImplementation((_c: unknown, onEvent: (e: AgentEvent) => void) => ({
      cancel: vi.fn(),
      interrupt: vi.fn(),
      getHookManager: vi.fn().mockReturnValue(pastHooks),
      run: vi.fn(async () => {
        onEvent({ type: 'agent_complete' } as AgentEvent);
      }),
    }));
    await agent.run('h2');
    expect(agent.getHookManager()).toEqual(pastHooks);
  });

  it('getLastRunContext is set after run', async () => {
    installLoop(async (ctl) => {
      ctl.onEvent({ type: 'agent_complete' } as AgentEvent);
    });
    const agent = new CLIAgent();
    expect(agent.getLastRunContext()).toBeNull();
    await agent.run('ctx');
    expect(agent.getLastRunContext()).toEqual(
      expect.objectContaining({ sessionId: 'sess-1' }),
    );
  });
});

describe('CLIAgent concurrent guard (isolated)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.buildCLIConfig.mockReturnValue({ ...baseConfig });
    mocks.getSessionManager.mockReturnValue(makeSessionManager());
    mocks.getSessionSkillService.mockReturnValue({ autoMountDefaultSkills: vi.fn() });
    mocks.addSwarmEventListener.mockReturnValue(() => {});
  });

  it('second run while first in-flight returns already-running', async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });

    mocks.createAgentLoop.mockImplementation((_c: unknown, onEvent: (e: AgentEvent) => void) => ({
      cancel: vi.fn(),
      interrupt: vi.fn(),
      getHookManager: vi.fn(),
      run: vi.fn(async () => {
        await gate;
        onEvent({ type: 'agent_complete' } as AgentEvent);
      }),
    }));

    const agent = new CLIAgent();
    const first = agent.run('a');
    await Promise.resolve();
    await Promise.resolve();

    const second = await agent.run('b');
    expect(second).toEqual({ success: false, error: 'Agent is already running' });

    release?.();
    const firstResult = await first;
    expect(firstResult.success).toBe(true);
  });
});
