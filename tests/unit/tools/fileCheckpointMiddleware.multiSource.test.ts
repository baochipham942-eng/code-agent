import { describe, expect, it, vi } from 'vitest';
import { createWorkspaceScope } from '../../../src/host/runtime/workspaceScope';

const mocks = vi.hoisted(() => ({
  createCheckpoint: vi.fn(),
}));

vi.mock('../../../src/host/services/checkpoint', () => ({
  getFileCheckpointService: () => ({ createCheckpoint: mocks.createCheckpoint }),
}));

import { createFileCheckpointIfNeeded } from '../../../src/host/tools/middleware/fileCheckpointMiddleware';

describe('fileCheckpointMiddleware multi-source attribution', () => {
  it('records Source identity and immutable scope version for a write checkpoint', async () => {
    const scope = createWorkspaceScope('project-1', [
      { sourceId: 'primary', path: '/repo/main', role: 'primary', access: 'read_write' },
      { sourceId: 'docs', path: '/repo/docs', role: 'additional', access: 'read_write' },
    ]);

    await createFileCheckpointIfNeeded(
      'Write',
      { file_path: '/repo/docs/guide.md' },
      () => ({ sessionId: 'session-1', messageId: 'message-1', workspaceScope: scope }),
      '/repo/main',
    );

    expect(mocks.createCheckpoint).toHaveBeenCalledWith(
      'session-1',
      'message-1',
      '/repo/docs/guide.md',
      {
        sourceId: 'docs',
        workspaceScopeVersion: scope.version,
      },
    );
  });
});
