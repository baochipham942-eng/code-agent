import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AgentAppServiceImpl } from '../../../src/host/app/agentAppService';
import { getFileCheckpointService } from '../../../src/host/services/checkpoint';
import { getDatabase } from '../../../src/host/services/core/databaseService';

vi.mock('../../../src/host/services', () => ({
  getSessionManager: vi.fn(() => ({
    invalidateSessionCache: vi.fn(),
  })),
}));

vi.mock('../../../src/host/services/checkpoint', () => ({
  getFileCheckpointService: vi.fn(),
}));

vi.mock('../../../src/host/services/core/databaseService', () => ({
  getDatabase: vi.fn(),
}));

vi.mock('../../../src/host/services/auth/authService', () => ({
  getAuthService: vi.fn(() => ({
    getCurrentUser: vi.fn(() => null),
  })),
}));

describe('AgentAppService explicit workspace file restore', () => {
  const database = {
    getSession: vi.fn(),
    applyPromptRewind: vi.fn(),
    restorePromptRewind: vi.fn(),
  };
  const checkpointService = {
    getCheckpoints: vi.fn(),
    rewindFiles: vi.fn(),
  };
  const taskManager = {
    getSessionState: vi.fn(),
    setSessionContext: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    database.getSession.mockReturnValue({
      id: 'session-1',
      projectId: 'project-1',
      status: 'idle',
    });
    checkpointService.getCheckpoints.mockResolvedValue([{
      id: 'checkpoint-1',
      sessionId: 'session-1',
      messageId: 'assistant-anchor-1',
      filePath: '/workspace/file.ts',
      originalContent: 'before',
      fileExisted: true,
      createdAt: 1,
    }]);
    taskManager.getSessionState.mockReturnValue({ status: 'idle' });
    vi.mocked(getDatabase).mockReturnValue(database as never);
    vi.mocked(getFileCheckpointService).mockReturnValue(checkpointService as never);
  });

  function createService(): AgentAppServiceImpl {
    return new AgentAppServiceImpl(
      () => taskManager as never,
      () => null,
      () => 'session-1',
      vi.fn(),
    );
  }

  it('restores files through the checkpoint service without changing conversation visibility', async () => {
    checkpointService.rewindFiles.mockResolvedValue({
      success: true,
      restoredFiles: ['/workspace/file.ts'],
      deletedFiles: ['/workspace/new-file.ts'],
      errors: [],
    });

    await expect(createService().restoreWorkspaceFilesAtCheckpoint({
      sessionId: 'session-1',
      checkpointMessageId: 'assistant-anchor-1',
    })).resolves.toEqual({
      success: true,
      sessionId: 'session-1',
      checkpointMessageId: 'assistant-anchor-1',
      restoredFileCount: 1,
      deletedFileCount: 1,
      workspaceChanged: true,
      conversationChanged: false,
    });

    expect(checkpointService.rewindFiles).toHaveBeenCalledWith(
      'session-1',
      'assistant-anchor-1',
    );
    expect(database.applyPromptRewind).not.toHaveBeenCalled();
    expect(database.restorePromptRewind).not.toHaveBeenCalled();
    expect(taskManager.setSessionContext).not.toHaveBeenCalled();
  });

  it('fails closed before file writes when the checkpoint anchor is missing', async () => {
    checkpointService.getCheckpoints.mockResolvedValue([]);

    await expect(createService().restoreWorkspaceFilesAtCheckpoint({
      sessionId: 'session-1',
      checkpointMessageId: 'missing-anchor',
    })).rejects.toMatchObject({
      code: 'CHECKPOINT_NOT_FOUND',
    });

    expect(checkpointService.rewindFiles).not.toHaveBeenCalled();
    expect(database.applyPromptRewind).not.toHaveBeenCalled();
    expect(database.restorePromptRewind).not.toHaveBeenCalled();
    expect(taskManager.setSessionContext).not.toHaveBeenCalled();
  });

  it('reports checkpoint service failure without changing conversation visibility', async () => {
    checkpointService.rewindFiles.mockResolvedValue({
      success: false,
      restoredFiles: ['/workspace/partial.ts'],
      deletedFiles: [],
      errors: [{ filePath: '/workspace/failed.ts', error: 'injected write failure' }],
    });

    await expect(createService().restoreWorkspaceFilesAtCheckpoint({
      sessionId: 'session-1',
      checkpointMessageId: 'assistant-anchor-1',
    })).rejects.toMatchObject({
      code: 'WORKSPACE_FILE_RESTORE_FAILED',
      restoredFileCount: 1,
      deletedFileCount: 0,
      failedFileCount: 1,
    });

    expect(database.applyPromptRewind).not.toHaveBeenCalled();
    expect(database.restorePromptRewind).not.toHaveBeenCalled();
    expect(taskManager.setSessionContext).not.toHaveBeenCalled();
  });

  it('rejects a running session before invoking the checkpoint service', async () => {
    taskManager.getSessionState.mockReturnValue({ status: 'running' });

    await expect(createService().restoreWorkspaceFilesAtCheckpoint({
      sessionId: 'session-1',
      checkpointMessageId: 'assistant-anchor-1',
    })).rejects.toMatchObject({
      code: 'SESSION_RUNNING',
    });

    expect(checkpointService.getCheckpoints).not.toHaveBeenCalled();
    expect(checkpointService.rewindFiles).not.toHaveBeenCalled();
  });
});
