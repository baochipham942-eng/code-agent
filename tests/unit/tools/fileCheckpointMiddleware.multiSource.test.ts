import { describe, expect, it, vi } from 'vitest';
import { createWorkspaceScope } from '../../../src/host/runtime/workspaceScope';

const mocks = vi.hoisted(() => ({
  createCheckpoint: vi.fn(),
  recordUncertainWriteTarget: vi.fn(),
}));

vi.mock('../../../src/host/services/checkpoint', () => ({
  getFileCheckpointService: () => ({
    createCheckpoint: mocks.createCheckpoint,
    recordUncertainWriteTarget: mocks.recordUncertainWriteTarget,
  }),
}));

import { createFileCheckpointIfNeeded } from '../../../src/host/tools/middleware/fileCheckpointMiddleware';
import { writeSchema } from '../../../src/host/tools/modules/file/write.schema';
import type { ToolDefinition } from '../../../src/shared/contract';
import type { ToolSchema } from '../../../src/host/protocol/tools';

// 照生产 adapter（dispatch/toolDefinitions.ts schemaToDefinition）的映射形状取字段
function toDefinition(schema: ToolSchema): ToolDefinition {
  return {
    name: schema.name,
    description: schema.description,
    inputSchema: schema.inputSchema as unknown as ToolDefinition['inputSchema'],
    outputSchema: schema.outputSchema as unknown as ToolDefinition['outputSchema'],
    requiresPermission: schema.requiresPermission ?? schema.permissionLevel !== 'read',
    permissionLevel: schema.permissionLevel === 'dangerous' ? 'execute' : schema.permissionLevel,
    pathAuthority: schema.pathAuthority,
  };
}

const writeDefinition = toDefinition(writeSchema);

describe('fileCheckpointMiddleware multi-source attribution', () => {
  it('records Source identity and immutable scope version for a write checkpoint', async () => {
    const scope = createWorkspaceScope('project-1', [
      { sourceId: 'primary', path: '/repo/main', role: 'primary', access: 'read_write' },
      { sourceId: 'docs', path: '/repo/docs', role: 'additional', access: 'read_write' },
    ]);
    mocks.createCheckpoint.mockResolvedValue('ckpt-1');

    const checkpoints = await createFileCheckpointIfNeeded(
      writeDefinition,
      { file_path: '/repo/docs/guide.md' },
      () => ({ sessionId: 'session-1', messageId: 'message-1', workspaceScope: scope }),
      '/repo/main',
    );

    expect(checkpoints).toEqual([{ checkpointId: 'ckpt-1', filePath: '/repo/docs/guide.md' }]);
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
