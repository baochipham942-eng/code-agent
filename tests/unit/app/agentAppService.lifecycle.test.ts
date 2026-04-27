import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentAppServiceImpl } from '../../../src/main/app/agentAppService';
import type { SessionStatus } from '../../../src/main/task';
import { getSessionManager } from '../../../src/main/services';
import { loadStreamSnapshot } from '../../../src/main/session/streamSnapshot';

vi.mock('../../../src/main/services', () => ({
  getSessionManager: vi.fn(),
}));

vi.mock('../../../src/main/session/streamSnapshot', () => ({
  loadStreamSnapshot: vi.fn(),
}));

function createService(taskManager: unknown, currentSessionId = 'session-1'): AgentAppServiceImpl {
  return new AgentAppServiceImpl(
    () => taskManager as never,
    () => null,
    () => currentSessionId,
    vi.fn(),
  );
}

describe('AgentAppService lifecycle routing', () => {
  let orchestrator: {
    cancel: ReturnType<typeof vi.fn>;
    setWorkingDirectory: ReturnType<typeof vi.fn>;
  };
  let sessionManager: {
    getSession: ReturnType<typeof vi.fn>;
    updateSession: ReturnType<typeof vi.fn>;
    restoreSession: ReturnType<typeof vi.fn>;
  };
  let taskManager: {
    getSessionState: ReturnType<typeof vi.fn>;
    startTask: ReturnType<typeof vi.fn>;
    interruptAndContinue: ReturnType<typeof vi.fn>;
    cancelTask: ReturnType<typeof vi.fn>;
    getOrCreateCurrentOrchestrator: ReturnType<typeof vi.fn>;
    setCurrentSessionId: ReturnType<typeof vi.fn>;
    setSessionContext: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    orchestrator = {
      cancel: vi.fn().mockResolvedValue(undefined),
      setWorkingDirectory: vi.fn(),
    };
    sessionManager = {
      getSession: vi.fn().mockResolvedValue({ id: 'session-1', workingDirectory: '/old/project' }),
      updateSession: vi.fn().mockResolvedValue(undefined),
      restoreSession: vi.fn(),
    };
    taskManager = {
      getSessionState: vi.fn(),
      startTask: vi.fn().mockResolvedValue(undefined),
      interruptAndContinue: vi.fn().mockResolvedValue(undefined),
      cancelTask: vi.fn().mockResolvedValue(undefined),
      getOrCreateCurrentOrchestrator: vi.fn(() => orchestrator),
      setCurrentSessionId: vi.fn(),
      setSessionContext: vi.fn(),
    };
    vi.mocked(getSessionManager).mockReset();
    vi.mocked(getSessionManager).mockReturnValue(sessionManager as any);
    vi.mocked(loadStreamSnapshot).mockReset();
  });

  it('routes chat send through TaskManager with run options and workbench metadata', async () => {
    const service = createService(taskManager);

    await service.sendMessage({
      sessionId: 'session-1',
      content: 'hello',
      attachments: [{ name: 'a.txt' }],
      context: {
        workingDirectory: '/tmp/project',
        selectedSkillIds: ['docx'],
      },
      options: { researchMode: false },
    } as any);

    expect(orchestrator.setWorkingDirectory).toHaveBeenCalledWith('/tmp/project');
    expect(sessionManager.updateSession).toHaveBeenCalledWith(
      'session-1',
      expect.objectContaining({ workingDirectory: '/tmp/project' }),
    );
    expect(taskManager.startTask).toHaveBeenCalledWith(
      'session-1',
      'hello',
      [{ name: 'a.txt' }],
      expect.objectContaining({
        researchMode: false,
        toolScope: expect.objectContaining({ allowedSkillIds: ['docx'] }),
      }),
      expect.objectContaining({
        workbench: expect.objectContaining({ workingDirectory: '/tmp/project', selectedSkillIds: ['docx'] }),
      }),
    );
  });

  it('routes interrupt-and-continue through TaskManager to keep the run owner consistent', async () => {
    const service = createService(taskManager);

    await service.interruptAndContinue({
      sessionId: 'session-1',
      content: 'steer',
      clientMessageId: 'client-msg-1',
      context: {
        workingDirectory: '/tmp/project',
        executionIntent: { allowBrowserAutomation: false },
      },
    } as any);

    expect(taskManager.interruptAndContinue).toHaveBeenCalledWith(
      'session-1',
      'steer',
      undefined,
      expect.objectContaining({
        executionIntent: { allowBrowserAutomation: false },
      }),
      expect.objectContaining({
        workbench: expect.objectContaining({
          workingDirectory: '/tmp/project',
          executionIntent: { allowBrowserAutomation: false },
        }),
      }),
      'client-msg-1',
    );
  });

  it.each(['running', 'paused', 'queued', 'cancelling'] as SessionStatus[])(
    'routes %s cancellation through TaskManager',
    async (status) => {
      taskManager.getSessionState.mockReturnValue({ status });
      const service = createService(taskManager);

      await service.cancel('session-1');

      expect(taskManager.cancelTask).toHaveBeenCalledWith('session-1');
      expect(taskManager.getOrCreateCurrentOrchestrator).not.toHaveBeenCalled();
      expect(orchestrator.cancel).not.toHaveBeenCalled();
    },
  );

  it('falls back to direct orchestrator cancellation for an untracked session', async () => {
    taskManager.getSessionState.mockReturnValue({ status: 'idle' });
    const service = createService(taskManager);

    await service.cancel('session-1');

    expect(taskManager.cancelTask).not.toHaveBeenCalled();
    expect(taskManager.getOrCreateCurrentOrchestrator).toHaveBeenCalledWith('session-1');
    expect(orchestrator.cancel).toHaveBeenCalledTimes(1);
  });

  it('restores incomplete stream snapshots for the loaded session', async () => {
    sessionManager.restoreSession.mockResolvedValue({
        id: 'session-1',
        title: 'Streaming Session',
        modelConfig: { provider: 'mock', model: 'mock-model' },
        workingDirectory: '/tmp/project',
        createdAt: 1,
        updatedAt: 2,
        messages: [],
    });
    vi.mocked(loadStreamSnapshot).mockReturnValue({
      sessionId: 'session-1',
      turnId: 'turn-1',
      content: '',
      reasoning: '',
      toolCalls: [
        { id: 'tool-1', name: 'write_file', arguments: '{"file_path":"/tmp/a"' },
      ],
      estimatedTokens: 1,
      timestamp: 100,
      isFinal: false,
      streamStatus: 'incomplete',
      stableForExecution: false,
      incompleteToolCallIds: ['tool-1'],
    });

    const service = createService(taskManager);
    const session = await service.loadSession('session-1');

    expect(loadStreamSnapshot).toHaveBeenCalledWith('/tmp/project');
    expect(session.streamSnapshot).toMatchObject({
      sessionId: 'session-1',
      turnId: 'turn-1',
      streamStatus: 'incomplete',
      stableForExecution: false,
      incompleteToolCallIds: ['tool-1'],
    });
    expect(taskManager.setCurrentSessionId).toHaveBeenCalledWith('session-1');
    expect(orchestrator.setWorkingDirectory).toHaveBeenCalledWith('/tmp/project');
  });

  it('ignores stream snapshots from another session', async () => {
    sessionManager.restoreSession.mockResolvedValue({
        id: 'session-1',
        title: 'Streaming Session',
        modelConfig: { provider: 'mock', model: 'mock-model' },
        workingDirectory: '/tmp/project',
        createdAt: 1,
        updatedAt: 2,
        messages: [],
    });
    vi.mocked(loadStreamSnapshot).mockReturnValue({
      sessionId: 'other-session',
      turnId: 'turn-1',
      content: '',
      reasoning: '',
      toolCalls: [],
      estimatedTokens: 1,
      timestamp: 100,
      isFinal: false,
      streamStatus: 'incomplete',
      stableForExecution: false,
      incompleteToolCallIds: [],
    });

    const service = createService(taskManager);
    const session = await service.loadSession('session-1');

    expect(session.streamSnapshot).toBeUndefined();
  });
});
