// ============================================================================
// runTUIChat — submit routing, cancel, status-from-event (via setEventObserver)
// ============================================================================

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from '../../../../src/shared/contract';

const mocks = vi.hoisted(() => {
  const updateStatus = vi.fn();
  const enter = vi.fn();
  const leave = vi.fn();
  const setInput = vi.fn();
  const clearInput = vi.fn();
  const start = vi.fn();
  const stop = vi.fn();
  const pause = vi.fn();
  const resume = vi.fn();
  const unpatch = vi.fn();
  const setTUIMode = vi.fn();
  const error = vi.fn();
  const execSync = vi.fn();

  return {
    updateStatus,
    enter,
    leave,
    setInput,
    clearInput,
    start,
    stop,
    pause,
    resume,
    unpatch,
    setTUIMode,
    error,
    execSync,
  };
});

vi.mock('../../../../src/cli/tui/index', () => ({
  createTUI: () => ({
    screen: {
      updateStatus: mocks.updateStatus,
      enter: mocks.enter,
      leave: mocks.leave,
      setInput: mocks.setInput,
      clearInput: mocks.clearInput,
      isActive: true,
    },
    input: {
      start: mocks.start,
      stop: mocks.stop,
      pause: mocks.pause,
      resume: mocks.resume,
    },
    unpatch: mocks.unpatch,
  }),
}));

vi.mock('../../../../src/cli/output', () => ({
  terminalOutput: {
    setTUIMode: mocks.setTUIMode,
    error: mocks.error,
  },
}));

vi.mock('child_process', () => ({
  execSync: (...args: unknown[]) => mocks.execSync(...args),
}));

import { runTUIChat } from '../../../../src/cli/tui/tuiChat';
import type { CLIAgent } from '../../../../src/cli/adapter';

type SubmitFn = (text: string) => void | Promise<void>;
type CancelFn = () => void;

function makeAgent(overrides: Partial<{
  run: ReturnType<typeof vi.fn>;
  cancel: ReturnType<typeof vi.fn>;
  getIsRunning: ReturnType<typeof vi.fn>;
  setEventObserver: ReturnType<typeof vi.fn>;
}> = {}): CLIAgent & {
  run: ReturnType<typeof vi.fn>;
  cancel: ReturnType<typeof vi.fn>;
  getIsRunning: ReturnType<typeof vi.fn>;
  setEventObserver: ReturnType<typeof vi.fn>;
  _observer: ((e: AgentEvent) => void) | null;
} {
  const agent = {
    _observer: null as ((e: AgentEvent) => void) | null,
    run: overrides.run ?? vi.fn().mockResolvedValue({ success: true, output: 'ok' }),
    cancel: overrides.cancel ?? vi.fn(),
    getIsRunning: overrides.getIsRunning ?? vi.fn().mockReturnValue(false),
    // 默认占位，falsy 分支会在下面被真正的捕获实现覆盖（避免 typeof agent 自引用）
    setEventObserver: overrides.setEventObserver ?? vi.fn(),
  };
  // rebind setEventObserver default to capture observer on this agent
  if (!overrides.setEventObserver) {
    agent.setEventObserver = vi.fn((obs: (e: AgentEvent) => void) => {
      agent._observer = obs;
    });
  }
  return agent as never;
}

describe('runTUIChat', () => {
  let submit: SubmitFn;
  let cancel: CancelFn;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.execSync.mockReturnValue('feature-branch\n');
    mocks.start.mockImplementation((onSubmit: SubmitFn, onCancel: CancelFn) => {
      submit = onSubmit;
      cancel = onCancel;
    });
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    // drop SIGINT handler registered by runTUIChat
    process.removeAllListeners('SIGINT');
  });

  async function startChat(
    agent: ReturnType<typeof makeAgent>,
    handleCommand = vi.fn().mockResolvedValue(true),
    cleanupFn = vi.fn().mockResolvedValue(undefined),
  ): Promise<{ cleanupFn: ReturnType<typeof vi.fn>; handleCommand: ReturnType<typeof vi.fn> }> {
    const p = runTUIChat(agent, handleCommand, cleanupFn);
    // let start() capture callbacks
    await Promise.resolve();
    expect(mocks.start).toHaveBeenCalled();
    return { cleanupFn, handleCommand, p } as never;
  }

  it('boots TUI: git branch status, event observer, tui mode, enter screen', async () => {
    const agent = makeAgent();
    void startChat(agent);

    await Promise.resolve();
    expect(mocks.execSync).toHaveBeenCalled();
    expect(mocks.updateStatus).toHaveBeenCalledWith(
      expect.objectContaining({ gitBranch: 'feature-branch', phase: 'idle' }),
    );
    expect(agent.setEventObserver).toHaveBeenCalled();
    expect(mocks.setTUIMode).toHaveBeenCalledWith(true);
    expect(mocks.enter).toHaveBeenCalled();
  });

  it('shell shortcut (!) runs execSync and resumes input without agent.run', async () => {
    const agent = makeAgent();
    void startChat(agent);
    await Promise.resolve();

    mocks.execSync.mockReturnValueOnce('feature-branch\n'); // already used on boot
    mocks.execSync.mockReturnValueOnce('hello\n');
    await submit('!echo hello');

    expect(agent.run).not.toHaveBeenCalled();
    expect(mocks.pause).toHaveBeenCalled();
    expect(mocks.resume).toHaveBeenCalled();
    expect(mocks.execSync).toHaveBeenCalledWith(
      'echo hello',
      expect.objectContaining({ timeout: 30000 }),
    );
  });

  it('slash /exit leaves TUI, disables tui mode, cleanup, and resolves', async () => {
    const agent = makeAgent();
    const cleanupFn = vi.fn().mockResolvedValue(undefined);
    const done = runTUIChat(agent, vi.fn(), cleanupFn);
    await Promise.resolve();

    await submit('/exit');
    await done;

    expect(mocks.setTUIMode).toHaveBeenCalledWith(false);
    expect(mocks.leave).toHaveBeenCalled();
    expect(mocks.unpatch).toHaveBeenCalled();
    expect(cleanupFn).toHaveBeenCalled();
  });

  it('other slash commands delegate to handleCommand then resume', async () => {
    const agent = makeAgent();
    const handleCommand = vi.fn().mockResolvedValue(true);
    void startChat(agent, handleCommand);
    await Promise.resolve();

    await submit('/status');
    expect(handleCommand).toHaveBeenCalledWith('/status', agent);
    expect(agent.run).not.toHaveBeenCalled();
    expect(mocks.resume).toHaveBeenCalled();
  });

  it('plain text runs agent, surfaces errors, returns phase idle + resume', async () => {
    const agent = makeAgent({
      run: vi.fn().mockResolvedValue({ success: false, error: 'boom' }),
    });
    void startChat(agent);
    await Promise.resolve();

    await submit('fix the bug');
    expect(agent.run).toHaveBeenCalledWith('fix the bug');
    expect(mocks.error).toHaveBeenCalledWith('boom');
    expect(mocks.updateStatus).toHaveBeenCalledWith({ phase: 'thinking' });
    expect(mocks.updateStatus).toHaveBeenCalledWith({ phase: 'idle' });
    expect(mocks.resume).toHaveBeenCalled();
  });

  it('agent.run throw is reported via terminalOutput.error', async () => {
    const agent = makeAgent({
      run: vi.fn().mockRejectedValue(new Error('network down')),
    });
    void startChat(agent);
    await Promise.resolve();

    await submit('hi');
    expect(mocks.error).toHaveBeenCalledWith('network down');
    expect(mocks.resume).toHaveBeenCalled();
  });

  it('cancel while running interrupts agent; cancel at prompt exits', async () => {
    const agent = makeAgent({
      getIsRunning: vi.fn().mockReturnValue(true),
      cancel: vi.fn(),
    });
    void startChat(agent);
    await Promise.resolve();

    cancel();
    expect(agent.cancel).toHaveBeenCalled();
    expect(mocks.updateStatus).toHaveBeenCalledWith({ phase: 'idle' });
    expect(mocks.resume).toHaveBeenCalled();

    // prompt exit path
    agent.getIsRunning.mockReturnValue(false);
    const cleanupFn = vi.fn().mockResolvedValue(undefined);
    const done = runTUIChat(agent, vi.fn(), cleanupFn);
    await Promise.resolve();
    cancel();
    await done;
    expect(mocks.leave).toHaveBeenCalled();
    expect(cleanupFn).toHaveBeenCalled();
  });

  it('event observer maps agent events onto status bar fields', async () => {
    const agent = makeAgent();
    void startChat(agent);
    await Promise.resolve();

    const obs = agent._observer;
    expect(obs).toBeTypeOf('function');

    obs!({ type: 'task_progress', data: { phase: 'thinking' } } as AgentEvent);
    expect(mocks.updateStatus).toHaveBeenCalledWith({ phase: 'thinking' });

    obs!({ type: 'task_progress', data: { phase: 'tool_running' } } as AgentEvent);
    expect(mocks.updateStatus).toHaveBeenCalledWith({ phase: 'running' });

    obs!({
      type: 'model_response',
      data: { model: 'test-model', provider: 'test', inputTokens: 100, outputTokens: 50 },
    } as AgentEvent);
    expect(mocks.updateStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'test-model',
        provider: 'test',
        inputTokens: 100,
        outputTokens: 50,
        cost: expect.any(Number),
      }),
    );

    obs!({
      type: 'stream_usage',
      data: { inputTokens: 200, outputTokens: 80 },
    } as AgentEvent);
    expect(mocks.updateStatus).toHaveBeenCalledWith(
      expect.objectContaining({ inputTokens: 200, outputTokens: 80 }),
    );

    obs!({
      type: 'task_complete',
      data: { duration: 1234, toolsUsed: ['Read', 'Read', 'Bash'] },
    } as AgentEvent);
    expect(mocks.updateStatus).toHaveBeenCalledWith(
      expect.objectContaining({ duration: 1234, toolCount: 2, phase: 'idle' }),
    );

    obs!({ type: 'task_stats', data: { contextUsage: 0.42 } } as AgentEvent);
    expect(mocks.updateStatus).toHaveBeenCalledWith({ contextPercent: 42 });

    obs!({ type: 'turn_start', data: { iteration: 5 } } as AgentEvent);
    expect(mocks.updateStatus).toHaveBeenCalledWith({ turns: 5 });

    obs!({ type: 'agent_complete' } as AgentEvent);
    expect(mocks.updateStatus).toHaveBeenCalledWith({ phase: 'idle' });
  });
});
