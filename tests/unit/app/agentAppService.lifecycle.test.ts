 
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentAppServiceImpl } from '../../../src/main/app/agentAppService';
import type { SessionStatus } from '../../../src/main/task';
import { getSessionManager } from '../../../src/main/services';
import { getDatabase } from '../../../src/main/services/core/databaseService';
import { getFileCheckpointService } from '../../../src/main/services/checkpoint';
import { loadStreamSnapshot } from '../../../src/main/session/streamSnapshot';

vi.mock('../../../src/main/services', () => ({
  getSessionManager: vi.fn(),
}));

vi.mock('../../../src/main/session/streamSnapshot', () => ({
  loadStreamSnapshot: vi.fn(),
}));

vi.mock('../../../src/main/services/core/databaseService', () => ({
  getDatabase: vi.fn(),
}));

vi.mock('../../../src/main/services/checkpoint', () => ({
  getFileCheckpointService: vi.fn(),
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
	    applyPromptRewind: ReturnType<typeof vi.fn>;
	  };
  let database: {
    getMessageById: ReturnType<typeof vi.fn>;
  };
  let checkpointService: {
    getFirstCheckpointAtOrAfter: ReturnType<typeof vi.fn>;
    rewindFiles: ReturnType<typeof vi.fn>;
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
	      applyPromptRewind: vi.fn(),
	    };
    database = {
      getMessageById: vi.fn(),
    };
    checkpointService = {
      getFirstCheckpointAtOrAfter: vi.fn(),
      rewindFiles: vi.fn(),
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
    vi.mocked(getDatabase).mockReset();
    vi.mocked(getDatabase).mockReturnValue(database as any);
    vi.mocked(getFileCheckpointService).mockReset();
    vi.mocked(getFileCheckpointService).mockReturnValue(checkpointService as any);
	  });

  it('routes chat send through TaskManager with run options and workbench metadata', async () => {
    const service = createService(taskManager);

    await service.sendMessage({
      sessionId: 'session-1',
      content: 'hello',
      clientMessageId: 'client-msg-send-1',
      attachments: [{ name: 'a.txt' }],
	      context: {
	        workingDirectory: '/tmp/project',
	        preferredAgentId: 'reviewer',
	        preferredAgentName: 'Reviewer',
	        selectedAgent: {
	          id: 'reviewer',
	          name: 'Reviewer',
	          token: 'reviewer',
	          via: 'slash_picker',
	        },
	        selectedPromptCommand: {
	          name: 'review',
	          source: 'file',
	          hints: ['$ARGUMENTS'],
	          via: 'slash_picker',
	        },
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
	        workbench: expect.objectContaining({
	          workingDirectory: '/tmp/project',
	          preferredAgentId: 'reviewer',
	          preferredAgentName: 'Reviewer',
	          selectedAgent: {
	            id: 'reviewer',
	            name: 'Reviewer',
	            token: 'reviewer',
	            via: 'slash_picker',
	          },
	          selectedPromptCommand: {
	            name: 'review',
	            source: 'file',
	            hints: ['$ARGUMENTS'],
	            via: 'slash_picker',
	          },
	          selectedSkillIds: ['docx'],
	        }),
	      }),
      'client-msg-send-1',
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
        runtimeInput: { mode: 'supplement' },
      },
    } as any);

    expect(taskManager.interruptAndContinue).toHaveBeenCalledWith(
      'session-1',
      'steer',
      undefined,
      expect.objectContaining({
        executionIntent: { allowBrowserAutomation: false },
        runtimeInput: { mode: 'supplement' },
      }),
      expect.objectContaining({
        workbench: expect.objectContaining({
          workingDirectory: '/tmp/project',
          executionIntent: { allowBrowserAutomation: false },
          runtimeInputMode: 'supplement',
        }),
      }),
      'client-msg-1',
    );
  });

  it('rejects session update attempts that write Agent Engine metadata through the generic session route', async () => {
    const service = createService(taskManager);

    await expect(service.updateSession('session-1', {
      engine: { kind: 'codex_cli', permissionProfile: 'read_only' },
    } as any)).rejects.toThrow(/Agent Engine selector/);

    expect(sessionManager.updateSession).not.toHaveBeenCalled();
  });

  it('does not route interrupt-and-continue into native runtime for external engine sessions', async () => {
    sessionManager.getSession.mockResolvedValueOnce({
      id: 'session-1',
      workingDirectory: '/tmp/project',
      engine: { kind: 'codex_cli', permissionProfile: 'read_only', origin: 'manual' },
    });
    const service = createService(taskManager);

    await expect(service.interruptAndContinue({
      sessionId: 'session-1',
      content: 'steer',
    } as any)).rejects.toThrow(/external Agent Engine/);

    expect(taskManager.interruptAndContinue).not.toHaveBeenCalled();
  });

  it('lets TaskManager recover runtime follow-up when no orchestrator is currently attached', async () => {
    taskManager.getOrCreateCurrentOrchestrator.mockReturnValueOnce(undefined);
    const service = createService(taskManager);

    await service.interruptAndContinue({
      sessionId: 'session-orphan',
      content: '继续按新要求处理',
      clientMessageId: 'client-msg-2',
    } as any);

    expect(taskManager.interruptAndContinue).toHaveBeenCalledWith(
      'session-orphan',
      '继续按新要求处理',
      undefined,
      undefined,
      undefined,
      'client-msg-2',
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

  it('keeps the previous session running when switching sessions', async () => {
    sessionManager.restoreSession.mockResolvedValue({
      id: 'session-2',
      title: 'Next Session',
      modelConfig: { provider: 'mock', model: 'mock-model' },
      workingDirectory: '/tmp/project',
      createdAt: 1,
      updatedAt: 2,
      messages: [],
    });

    const service = createService(taskManager, 'session-1');
    await service.loadSession('session-2');

    expect(orchestrator.cancel).not.toHaveBeenCalled();
    expect(taskManager.setCurrentSessionId).toHaveBeenCalledWith('session-2');
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

  it('rewinds files before hiding messages and returns the original prompt as draft', async () => {
    taskManager.getSessionState.mockReturnValue({ status: 'idle' });
    database.getMessageById.mockReturnValue({
      id: 'u2',
      role: 'user',
      content: 'rewrite this prompt',
      timestamp: 30,
      attachments: [{ name: 'brief.md' }],
    });
    checkpointService.getFirstCheckpointAtOrAfter.mockResolvedValue({
      messageId: 'tool-message-1',
      createdAt: 31,
    });
    checkpointService.rewindFiles.mockResolvedValue({
      success: true,
      restoredFiles: ['/tmp/a.ts'],
      deletedFiles: ['/tmp/new.ts'],
      errors: [],
    });
    sessionManager.applyPromptRewind.mockResolvedValue({
      rewindId: 'rewind-1',
      activeMessages: [{ id: 'u1', role: 'user', content: 'previous', timestamp: 10 }],
      hiddenMessageCount: 2,
    });

    const service = createService(taskManager);
    const result = await service.rewindToPrompt({ sessionId: 'session-1', userMessageId: 'u2' });

    expect(checkpointService.getFirstCheckpointAtOrAfter).toHaveBeenCalledWith('session-1', 30);
    expect(checkpointService.rewindFiles).toHaveBeenCalledWith('session-1', 'tool-message-1');
    expect(sessionManager.applyPromptRewind).toHaveBeenCalledWith(
      'session-1',
      'u2',
      expect.objectContaining({
        checkpointMessageId: 'tool-message-1',
        filesRestored: 1,
        filesDeleted: 1,
      }),
    );
    expect(taskManager.setSessionContext).toHaveBeenCalledWith('session-1', [
      { id: 'u1', role: 'user', content: 'previous', timestamp: 10 },
    ]);
    expect(result).toMatchObject({
      success: true,
      draft: { content: 'rewrite this prompt', attachments: [{ name: 'brief.md' }] },
      hiddenMessageCount: 2,
      filesRestored: 1,
      filesDeleted: 1,
    });
  });

  it('does not hide messages when file rewind fails', async () => {
    taskManager.getSessionState.mockReturnValue({ status: 'idle' });
    database.getMessageById.mockReturnValue({
      id: 'u2',
      role: 'user',
      content: 'rewrite this prompt',
      timestamp: 30,
    });
    checkpointService.getFirstCheckpointAtOrAfter.mockResolvedValue({
      messageId: 'tool-message-1',
      createdAt: 31,
    });
    checkpointService.rewindFiles.mockResolvedValue({
      success: false,
      restoredFiles: [],
      deletedFiles: [],
      errors: [{ filePath: '/tmp/a.ts', error: 'permission denied' }],
    });

    const service = createService(taskManager);
    await expect(service.rewindToPrompt({ sessionId: 'session-1', userMessageId: 'u2' })).rejects.toThrow(
      'permission denied',
    );

    expect(sessionManager.applyPromptRewind).not.toHaveBeenCalled();
    expect(taskManager.setSessionContext).not.toHaveBeenCalled();
  });

  it.each(['running', 'queued', 'cancelling'] as SessionStatus[])(
    'rejects prompt rewind while session is %s',
    async (status) => {
      taskManager.getSessionState.mockReturnValue({ status });
      const service = createService(taskManager);

      await expect(service.rewindToPrompt({ sessionId: 'session-1', userMessageId: 'u2' })).rejects.toThrow(
        'Cannot rewind while the session is running',
      );
      expect(database.getMessageById).not.toHaveBeenCalled();
    },
  );
	});
