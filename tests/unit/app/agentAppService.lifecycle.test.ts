 
import { readFile } from 'node:fs/promises';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentAppServiceImpl } from '../../../src/host/app/agentAppService';
import { DurableRunReadService } from '../../../src/host/app/durableRunReadService';
import { resolveDurableRunRollout } from '../../../src/host/app/durableRunRollout';
import type { SessionStatus } from '../../../src/host/task';
import { getSessionManager } from '../../../src/host/services';
import { getDatabase } from '../../../src/host/services/core/databaseService';
import { getFileCheckpointService } from '../../../src/host/services/checkpoint';
import { loadStreamSnapshot } from '../../../src/host/session/streamSnapshot';

vi.mock('../../../src/host/services', () => ({
  getSessionManager: vi.fn(),
}));

vi.mock('../../../src/host/session/streamSnapshot', () => ({
  loadStreamSnapshot: vi.fn(),
}));

vi.mock('../../../src/host/services/core/databaseService', () => ({
  getDatabase: vi.fn(),
}));

vi.mock('../../../src/host/services/checkpoint', () => ({
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

function createServiceWithConfig(taskManager: unknown, configService: unknown, currentSessionId = 'session-1'): AgentAppServiceImpl {
  return new AgentAppServiceImpl(
    () => taskManager as never,
    () => configService as never,
    () => currentSessionId,
    vi.fn(),
  );
}

function createServiceWithDurableReadService(
  taskManager: unknown,
  durableRunReadService: DurableRunReadService,
  currentSessionId = 'session-1',
): AgentAppServiceImpl {
  return new AgentAppServiceImpl(
    () => taskManager as never,
    () => null,
    () => currentSessionId,
    vi.fn(),
    undefined,
    durableRunReadService,
  );
}

function durableEnvelope(status: 'waiting' | 'running' | 'completed' | 'failed' | 'cancelled', sessionId = 'session-1') {
  return {
    schemaVersion: 1 as const,
    runId: `run-${status}`,
    sessionId,
    engine: { kind: 'native' as const },
    status,
    attempt: 1,
    cursor: { nextEventSeq: 2, checkpointSeq: 1 },
    ...(status === 'completed' || status === 'failed' || status === 'cancelled'
      ? { terminal: { status, eventSeq: 1, at: 2 } }
      : {}),
    createdAt: 1,
    updatedAt: 2,
  };
}

describe('AgentAppService lifecycle routing', () => {
  let orchestrator: {
    cancel: ReturnType<typeof vi.fn>;
    getWorkingDirectory: ReturnType<typeof vi.fn>;
    setWorkingDirectory: ReturnType<typeof vi.fn>;
  };
	  let sessionManager: {
	    getSession: ReturnType<typeof vi.fn>;
	    listSessions: ReturnType<typeof vi.fn>;
	    createSession: ReturnType<typeof vi.fn>;
	    setCurrentSession: ReturnType<typeof vi.fn>;
	    updateSession: ReturnType<typeof vi.fn>;
	    restoreSession: ReturnType<typeof vi.fn>;
	    applyPromptRewind: ReturnType<typeof vi.fn>;
	    invalidateSessionCache: ReturnType<typeof vi.fn>;
	  };
  let database: {
    getMessageById: ReturnType<typeof vi.fn>;
    getMessages: ReturnType<typeof vi.fn>;
    getSession: ReturnType<typeof vi.fn>;
    createSessionFork: ReturnType<typeof vi.fn>;
    getSessionForkLineage: ReturnType<typeof vi.fn>;
    listSessionForkChildren: ReturnType<typeof vi.fn>;
    getSessionForkWorkspaceScope: ReturnType<typeof vi.fn>;
    applyPromptRewind: ReturnType<typeof vi.fn>;
    restorePromptRewind: ReturnType<typeof vi.fn>;
    repairConversationLineage: ReturnType<typeof vi.fn>;
  };
  let checkpointService: {
    getFirstCheckpointAtOrAfter: ReturnType<typeof vi.fn>;
    rewindFiles: ReturnType<typeof vi.fn>;
  };
  let taskManager: {
    getSessionState: ReturnType<typeof vi.fn>;
    startTask: ReturnType<typeof vi.fn>;
    interruptAndContinue: ReturnType<typeof vi.fn>;
    cleanup: ReturnType<typeof vi.fn>;
    cancelTask: ReturnType<typeof vi.fn>;
    getOrCreateCurrentOrchestrator: ReturnType<typeof vi.fn>;
    setCurrentSessionId: ReturnType<typeof vi.fn>;
    setSessionContext: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    orchestrator = {
      cancel: vi.fn().mockResolvedValue(undefined),
      getWorkingDirectory: vi.fn(() => '/current/project'),
      setWorkingDirectory: vi.fn(),
    };
	    sessionManager = {
	      getSession: vi.fn().mockResolvedValue({ id: 'session-1', workingDirectory: '/old/project' }),
	      listSessions: vi.fn().mockResolvedValue([]),
	      createSession: vi.fn(async (options) => ({
	        id: 'created-session',
	        title: options.title,
	        modelConfig: options.modelConfig,
	        workingDirectory: options.workingDirectory,
	        createdAt: 1,
	        updatedAt: 1,
	      })),
	      setCurrentSession: vi.fn(),
	      updateSession: vi.fn().mockResolvedValue(undefined),
	      restoreSession: vi.fn(),
	      applyPromptRewind: vi.fn(),
	      invalidateSessionCache: vi.fn(),
	    };
    database = {
      getMessageById: vi.fn(),
      getMessages: vi.fn(),
      getSession: vi.fn(),
      createSessionFork: vi.fn(),
      getSessionForkLineage: vi.fn(),
      listSessionForkChildren: vi.fn(),
      getSessionForkWorkspaceScope: vi.fn().mockReturnValue(null),
      applyPromptRewind: vi.fn(),
      restorePromptRewind: vi.fn(),
      repairConversationLineage: vi.fn(),
    };
    checkpointService = {
      getFirstCheckpointAtOrAfter: vi.fn(),
      rewindFiles: vi.fn(),
    };
    taskManager = {
      getSessionState: vi.fn(),
      startTask: vi.fn().mockResolvedValue(undefined),
      interruptAndContinue: vi.fn().mockResolvedValue({ outcome: 'steered' }),
      cleanup: vi.fn(),
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

  it('routes public lineage repair to projection reconstruction with the exact owner/Project boundary', async () => {
    const healthyAudit = {
      status: 'healthy',
      issueDigest: 'healthy',
      issues: [],
    };
    database.getSession.mockReturnValue({
      id: 'session-1',
      projectId: 'project-1',
    });
    database.repairConversationLineage.mockReturnValue(healthyAudit);
    const service = createService(taskManager);

    await expect(service.repairConversationLineage({
      sessionId: 'session-1',
      issueDigest: 'issue-digest',
      reason: 'rebuild the compatibility projection from immutable replay',
      idempotencyKey: 'repair-1',
    })).resolves.toBe(healthyAudit);

    expect(database.getSession).toHaveBeenCalledWith('session-1', { userId: null });
    expect(database.repairConversationLineage).toHaveBeenCalledWith({
      sessionId: 'session-1',
      boundary: { ownerUserId: null, projectId: 'project-1' },
      issueDigest: 'issue-digest',
      reason: 'rebuild the compatibility projection from immutable replay',
      idempotencyKey: 'repair-1',
    });
  });

  it('keeps Desktop Codex and Claude fork handoff and continuation resume wiring exact', async () => {
    const source = await readFile(
      new URL('../../../src/host/app/agentAppService.ts', import.meta.url),
      'utf8',
    );
    const codexStart = source.indexOf("if (engine.kind === 'codex_cli')");
    const claudeStart = source.indexOf("if (engine.kind === 'claude_code')", codexStart);
    const mimoStart = source.indexOf("if (engine.kind === 'mimo_code')", claudeStart);

    expect(codexStart).toBeGreaterThanOrEqual(0);
    expect(claudeStart).toBeGreaterThan(codexStart);
    expect(mimoStart).toBeGreaterThan(claudeStart);

    const codexBlock = source.slice(codexStart, claudeStart);
    const claudeBlock = source.slice(claudeStart, mimoStart);
    for (const [block, builder, continuationError] of [
      [codexBlock, 'createCodexContinuationResumeLaunch', 'Codex continuation requires durable lifecycle identity'],
      [claudeBlock, 'createClaudeContinuationResumeLaunch', 'Claude continuation requires durable lifecycle identity'],
    ] as const) {
      expect(block).toContain(
        'const forkContext = persistedExternalSessionId\n'
        + '        ? null\n'
        + '        : await this.prepareExternalForkContext(',
      );
      expect(block).toContain('externalSessionId: persistedExternalSessionId');
      expect(block).toContain(continuationError);
      expect(block).toContain(`? ${builder}({`);
      expect(block).toContain('persistedExternalSessionId,');
      expect(block).toContain('lifecycle: durableLifecycle,');
      expect(block).toContain('durableLifecycle,');
      expect(block).toContain('resumeLaunch,');
      expect(block).toContain('forkContextHandoff: forkContext.handoff');
      expect(block).toContain('onForkContextDispatchStart: forkContext.onDispatchStart');
      expect(block).toContain('onForkContextDispatched: forkContext.onDispatched');
    }
  });

  it('keeps a new blank session out of the current project when workingDirectory is null', async () => {
    const service = createServiceWithConfig(taskManager, {
      getSettings: () => ({ model: { provider: 'openai', model: 'gpt-5.4' } }),
    });

    const session = await service.createSession({
      title: '空白会话',
      workingDirectory: null,
    });

    expect(session.workingDirectory).toBeUndefined();
    expect(sessionManager.createSession).toHaveBeenCalledWith(expect.objectContaining({
      title: '空白会话',
      workingDirectory: undefined,
    }));
    expect(orchestrator.setWorkingDirectory).not.toHaveBeenCalledWith('/current/project');
  });

  it('inherits the current project when a new session omits workingDirectory', async () => {
    const service = createServiceWithConfig(taskManager, {
      getSettings: () => ({ model: { provider: 'openai', model: 'gpt-5.4' } }),
    });

    const session = await service.createSession({ title: '新对话' });

    expect(session.workingDirectory).toBe('/current/project');
    expect(sessionManager.createSession).toHaveBeenCalledWith(expect.objectContaining({
      title: '新对话',
      workingDirectory: '/current/project',
    }));
    expect(orchestrator.setWorkingDirectory).toHaveBeenCalledWith('/current/project');
  });

  it('annotates listed durable waiting sessions without changing the running projection', async () => {
    sessionManager.listSessions.mockResolvedValue([
      {
        id: 'session-waiting',
        title: 'Waiting',
        status: 'idle',
        modelConfig: { provider: 'openai', model: 'gpt-5' },
        createdAt: 1,
        updatedAt: 10,
      },
      {
        id: 'session-running',
        title: 'Running',
        status: 'running',
        modelConfig: { provider: 'openai', model: 'gpt-5' },
        createdAt: 1,
        updatedAt: 11,
      },
      {
        id: 'session-completed',
        title: 'Completed',
        status: 'running',
        modelConfig: { provider: 'openai', model: 'gpt-5' },
        createdAt: 1,
        updatedAt: 12,
      },
      {
        id: 'session-failed',
        title: 'Failed',
        status: 'running',
        modelConfig: { provider: 'openai', model: 'gpt-5' },
        createdAt: 1,
        updatedAt: 13,
      },
      {
        id: 'session-cancelled',
        title: 'Cancelled',
        status: 'running',
        modelConfig: { provider: 'openai', model: 'gpt-5' },
        createdAt: 1,
        updatedAt: 14,
      },
    ]);
    const reader = {
      getLatestBySession: vi.fn(async (sessionId: string) => ({
        'session-waiting': durableEnvelope('waiting', 'session-waiting'),
        'session-running': durableEnvelope('running', 'session-running'),
        'session-completed': durableEnvelope('completed', 'session-completed'),
        'session-failed': durableEnvelope('failed', 'session-failed'),
        'session-cancelled': durableEnvelope('cancelled', 'session-cancelled'),
      })[sessionId] ?? null),
    };
    const service = createServiceWithDurableReadService(
      taskManager,
      new DurableRunReadService(
        resolveDurableRunRollout({ CODE_AGENT_DURABLE_RUN_MODE: 'durable_preferred' }),
        reader,
      ),
    );

    const sessions = await service.listSessions();

    expect(sessions).toEqual([
      expect.objectContaining({
        id: 'session-waiting',
        status: 'running',
        durableWaitingInput: true,
      }),
      expect.objectContaining({
        id: 'session-running',
        status: 'running',
      }),
      expect.objectContaining({
        id: 'session-completed',
        status: 'completed',
      }),
      expect.objectContaining({
        id: 'session-failed',
        status: 'error',
      }),
      expect.objectContaining({
        id: 'session-cancelled',
        status: 'interrupted',
      }),
    ]);
    expect(sessions[1]).not.toHaveProperty('durableWaitingInput');
    expect(sessions[2]).not.toHaveProperty('durableWaitingInput');
    expect(sessions[3]).not.toHaveProperty('durableWaitingInput');
    expect(sessions[4]).not.toHaveProperty('durableWaitingInput');
  });

  it('leaves listed sessions unchanged when durable rollout is not preferred or the durable row is missing', async () => {
    sessionManager.listSessions.mockResolvedValue([
      {
        id: 'session-legacy',
        title: 'Legacy',
        status: 'running',
        modelConfig: { provider: 'openai', model: 'gpt-5' },
        createdAt: 1,
        updatedAt: 10,
      },
    ]);
    const legacyReader = { getLatestBySession: vi.fn(async () => durableEnvelope('waiting', 'session-legacy')) };
    const legacyService = createServiceWithDurableReadService(
      taskManager,
      new DurableRunReadService(
        resolveDurableRunRollout({ CODE_AGENT_DURABLE_RUN_MODE: 'legacy' }),
        legacyReader,
      ),
    );

    await expect(legacyService.listSessions()).resolves.toEqual([
      expect.not.objectContaining({ durableWaitingInput: true }),
    ]);
    expect(legacyReader.getLatestBySession).not.toHaveBeenCalled();

    const missingReader = { getLatestBySession: vi.fn(async () => null) };
    const missingService = createServiceWithDurableReadService(
      taskManager,
      new DurableRunReadService(
        resolveDurableRunRollout({ CODE_AGENT_DURABLE_RUN_MODE: 'durable_preferred' }),
        missingReader,
      ),
    );

    await expect(missingService.listSessions()).resolves.toEqual([
      expect.not.objectContaining({ durableWaitingInput: true }),
    ]);
    expect(missingReader.getLatestBySession).toHaveBeenCalledWith('session-legacy');
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
        turnCapabilityScopeMode: 'manual',
      },
      options: {
        researchMode: false,
        modelSpec: { provider: 'xiaomi', model: 'mimo-v2.5-pro' },
      },
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
        modelSpec: { provider: 'xiaomi', model: 'mimo-v2.5-pro' },
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
          turnCapabilityScopeMode: 'manual',
        }),
      }),
      'client-msg-send-1',
    );
  });

  it('routes interrupt-and-continue through TaskManager to keep the run owner consistent', async () => {
    const expectedOutcome = { outcome: 'queued', queuedInputId: 'queued-input-1' } as const;
    taskManager.interruptAndContinue.mockResolvedValueOnce(expectedOutcome);
    const service = createService(taskManager);

    const outcome = await service.interruptAndContinue({
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
    expect(outcome).toBe(expectedOutcome);
  });

  it('backfills empty session working directory with the runtime effective value on first run', async () => {
    sessionManager.getSession.mockResolvedValue({ id: 'session-1' });
    const service = createService(taskManager);

    await service.sendMessage({
      sessionId: 'session-1',
      content: 'hello',
    } as any);

    expect(sessionManager.updateSession).toHaveBeenCalledWith(
      'session-1',
      expect.objectContaining({ workingDirectory: '/current/project' }),
    );
  });

  it('does not overwrite a persisted working directory with the runtime value', async () => {
    const service = createService(taskManager);

    await service.sendMessage({
      sessionId: 'session-1',
      content: 'hello',
    } as any);

    expect(orchestrator.setWorkingDirectory).toHaveBeenCalledWith('/old/project');
    expect(sessionManager.updateSession).not.toHaveBeenCalled();
  });

  it('keeps an isolated Fork on its verified child root when the renderer sends a stale source cwd', async () => {
    sessionManager.getSession.mockResolvedValue({
      id: 'session-1',
      projectId: 'project-1',
      workingDirectory: '/isolated/child',
      metadata: {
        forkLineage: { workspaceMode: 'isolated_at_anchor' },
        forkWorkspaceScopeV1: { version: 1 },
      },
    });
    database.getSessionForkWorkspaceScope.mockReturnValue({
      projectId: 'project-1',
      primaryRoot: '/isolated/child',
      roots: [{
        sourceId: 'isolated:intent-1',
        path: '/isolated/child',
        access: 'read_write',
        role: 'primary',
      }],
      version: `isolated-v1:intent-1:${'a'.repeat(64)}`,
    });
    const service = createService(taskManager);

    await service.sendMessage({
      sessionId: 'session-1',
      content: 'continue in the child',
      context: { workingDirectory: '/source/project' },
    } as any);

    expect(orchestrator.setWorkingDirectory).toHaveBeenCalledWith('/isolated/child');
    expect(orchestrator.setWorkingDirectory).not.toHaveBeenCalledWith('/source/project');
    expect(sessionManager.updateSession).not.toHaveBeenCalled();
    expect(taskManager.startTask).toHaveBeenCalledWith(
      'session-1',
      'continue in the child',
      undefined,
      undefined,
      expect.objectContaining({
        workbench: expect.objectContaining({ workingDirectory: '/isolated/child' }),
      }),
      undefined,
    );
  });

  it('skips working directory backfill when the runtime has no value', async () => {
    sessionManager.getSession.mockResolvedValue({ id: 'session-1' });
    orchestrator.getWorkingDirectory.mockReturnValue('');
    const service = createService(taskManager);

    await service.sendMessage({
      sessionId: 'session-1',
      content: 'hello',
    } as any);

    expect(sessionManager.updateSession).not.toHaveBeenCalled();
  });

  it('backfills empty session working directory on interrupt-and-continue', async () => {
    sessionManager.getSession.mockResolvedValue({ id: 'session-1' });
    const service = createService(taskManager);

    await service.interruptAndContinue({
      sessionId: 'session-1',
      content: 'steer',
    } as any);

    expect(sessionManager.updateSession).toHaveBeenCalledWith(
      'session-1',
      expect.objectContaining({ workingDirectory: '/current/project' }),
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
      schemaVersion: 2,
      workspace: '/tmp/project',
      sessionId: 'session-1',
      runId: 'run-1',
      turnId: 'turn-1',
      content: '',
      reasoning: '',
      toolCalls: [
        { id: 'tool-1', name: 'write_file', arguments: '{"file_path":"/tmp/a"' },
      ],
      estimatedTokens: 1,
      timestamp: 100,
      updatedAt: 100,
      isFinal: false,
      streamStatus: 'incomplete',
      stableForExecution: false,
      incompleteToolCallIds: ['tool-1'],
      executionToolCalls: [],
    });

    const service = createService(taskManager);
    const session = await service.loadSession('session-1');

    expect(loadStreamSnapshot).toHaveBeenCalledWith({
      workingDir: '/tmp/project',
      sessionId: 'session-1',
    });
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
      schemaVersion: 2,
      workspace: '/tmp/project',
      sessionId: 'other-session',
      runId: 'run-1',
      turnId: 'turn-1',
      content: '',
      reasoning: '',
      toolCalls: [],
      estimatedTokens: 1,
      timestamp: 100,
      updatedAt: 100,
      isFinal: false,
      streamStatus: 'incomplete',
      stableForExecution: false,
      incompleteToolCallIds: [],
      executionToolCalls: [],
    });

    const service = createService(taskManager);
    const session = await service.loadSession('session-1');

	    expect(session.streamSnapshot).toBeUndefined();
	  });

  it('routes a native fork through the transactional fork service without selecting or editing the source', async () => {
    const source = {
      id: 'session-1',
      title: 'Source task',
      modelConfig: { provider: 'openai', model: 'gpt-5' },
      workingDirectory: '/tmp/project',
      engine: { kind: 'native' },
      status: 'idle',
      createdAt: 1,
      updatedAt: 2,
    };
    const child = {
      ...source,
      id: 'session-child',
      title: 'Source task · 分支',
      parentSessionId: source.id,
      createdAt: 3,
      updatedAt: 3,
    };
    database.getSession.mockImplementation((id: string) => id === source.id ? source : child);
    database.createSessionFork.mockReturnValue({
      forkId: 'fork-1',
      childSessionId: child.id,
      copiedMessageCount: 4,
      sourcePrefixDigest: 'digest',
      lineage: {
        forkId: 'fork-1',
        rootSessionId: source.id,
        parentSessionId: source.id,
        childSessionId: child.id,
        sourceAnchorMessageId: 'a2',
        anchorChildMessageId: 'child-a2',
        depth: 1,
        workspaceMode: 'shared_current',
        contextDeliveryMode: 'neo_native_prefix',
        status: 'completed',
        syncState: 'local_only',
        createdAt: 3,
      },
      messageMappings: [],
    });
    database.getMessages.mockReturnValue([
      { id: 'u1-child', role: 'user', content: 'one', timestamp: 10 },
      { id: 'a1-child', role: 'assistant', content: 'one answer', timestamp: 20 },
      { id: 'u2-child', role: 'user', content: 'two', timestamp: 30 },
      { id: 'a2-child', role: 'assistant', content: 'two answer', timestamp: 40 },
    ]);
    taskManager.getSessionState.mockReturnValue({ status: 'idle' });

    const service = createService(taskManager);
    const result = await service.forkSession({
      sourceSessionId: source.id,
      anchorAssistantMessageId: 'a2',
      idempotencyKey: 'fork-request-1',
      workspaceMode: 'shared_current',
    });

    expect(result.childSession.id).toBe(child.id);
    expect(result.workspaceLabel).toBe('历史对话 + 当前文件');
    expect(database.createSessionFork).toHaveBeenCalledTimes(1);
    expect(sessionManager.applyPromptRewind).not.toHaveBeenCalled();
    expect(sessionManager.setCurrentSession).not.toHaveBeenCalled();
    expect(taskManager.setSessionContext).toHaveBeenCalledWith(child.id, [
      { id: 'u1-child', role: 'user', content: 'one', timestamp: 10 },
      { id: 'a1-child', role: 'assistant', content: 'one answer', timestamp: 20 },
      { id: 'u2-child', role: 'user', content: 'two', timestamp: 30 },
      { id: 'a2-child', role: 'assistant', content: 'two answer', timestamp: 40 },
    ]);
    expect(taskManager.setCurrentSessionId).not.toHaveBeenCalled();
  });

  it('soft-hides conversation history without changing workspace files', async () => {
    taskManager.getSessionState.mockReturnValue({ status: 'idle' });
    database.applyPromptRewind.mockReturnValue({
      rewindId: 'rewind-1',
      anchorMessage: {
        id: 'u2',
        role: 'user',
        content: 'rewrite this prompt',
        timestamp: 30,
        attachments: [{ name: 'brief.md' }],
        visibility: 'active',
      },
      hiddenMessageIds: ['a2'],
      activeMessages: [
        { id: 'u1', role: 'user', content: 'previous', timestamp: 10 },
        { id: 'u2', role: 'user', content: 'rewrite this prompt', timestamp: 30 },
      ],
      hiddenMessageCount: 1,
    });

    const service = createService(taskManager);
    const result = await service.rewindToPrompt({
      sessionId: 'session-1',
      userMessageId: 'u2',
      idempotencyKey: 'rewind-request-1',
    });

    expect(database.applyPromptRewind).toHaveBeenCalledWith(
      'session-1',
      'u2',
      { idempotencyKey: 'rewind-request-1', ownerUserId: null },
    );
    expect(checkpointService.getFirstCheckpointAtOrAfter).not.toHaveBeenCalled();
    expect(checkpointService.rewindFiles).not.toHaveBeenCalled();
    expect(taskManager.setSessionContext).toHaveBeenCalledWith('session-1', [
      { id: 'u1', role: 'user', content: 'previous', timestamp: 10 },
      { id: 'u2', role: 'user', content: 'rewrite this prompt', timestamp: 30 },
    ]);
    expect(result).toMatchObject({
      success: true,
      draft: { content: '' },
      hiddenMessageCount: 1,
      workspaceChanged: false,
      filesRestored: 0,
      filesDeleted: 0,
    });
  });

  it('does not alter runtime context when the rewind transaction fails', async () => {
    taskManager.getSessionState.mockReturnValue({ status: 'idle' });
    database.applyPromptRewind.mockImplementation(() => {
      throw new Error('injected rewind transaction failure');
    });

    const service = createService(taskManager);
    await expect(service.rewindToPrompt({ sessionId: 'session-1', userMessageId: 'u2' })).rejects.toThrow(
      'injected rewind transaction failure',
    );

    expect(checkpointService.rewindFiles).not.toHaveBeenCalled();
    expect(taskManager.setSessionContext).not.toHaveBeenCalled();
  });

  it.each(['running', 'queued', 'cancelling'] as SessionStatus[])(
    'rejects prompt rewind while session is %s',
    async (status) => {
      taskManager.getSessionState.mockReturnValue({ status });
      const service = createService(taskManager);

      await expect(service.rewindToPrompt({ sessionId: 'session-1', userMessageId: 'u2' })).rejects.toThrow(
        'SESSION_RUNNING',
      );
      expect(database.applyPromptRewind).not.toHaveBeenCalled();
    },
  );
	});
