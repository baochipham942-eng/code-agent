import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ invokeDomain: vi.fn() }));

vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: { invokeDomain: mocks.invokeDomain },
}));

import { getSurfaceExecutionOutput } from '../../../src/renderer/services/surfaceExecutionClient';

describe('surfaceExecutionClient output', () => {
  beforeEach(() => vi.clearAllMocks());

  it('accepts a matching safe output payload', async () => {
    mocks.invokeDomain.mockResolvedValue({
      version: 1,
      outputRef: 'surface-output://output-1',
      contentKind: 'text',
      mimeType: 'text/html',
      text: '<title>safe</title>',
      truncated: false,
      bytes: 19,
      sha256: 'a'.repeat(64),
    });
    const request = {
      version: 1 as const,
      conversationId: 'conversation-1',
      surfaceSessionId: 'surface-1',
      outputRef: 'surface-output://output-1',
    };

    await expect(getSurfaceExecutionOutput(request)).resolves.toMatchObject({
      outputRef: request.outputRef,
      contentKind: 'text',
    });
    expect(mocks.invokeDomain).toHaveBeenCalledWith(
      'domain:surfaceExecution',
      'getOutput',
      request,
    );
  });

  it('rejects mismatched refs and path-bearing payloads', async () => {
    mocks.invokeDomain.mockResolvedValue({
      version: 1,
      outputRef: 'surface-output://output-1',
      contentKind: 'text',
      mimeType: 'text/html',
      text: 'private',
      truncated: false,
      bytes: 7,
      sha256: 'b'.repeat(64),
      rawPath: '/tmp/private.html',
    });
    await expect(getSurfaceExecutionOutput({
      version: 1,
      conversationId: 'conversation-1',
      surfaceSessionId: 'surface-1',
      outputRef: 'surface-output://output-1',
    })).rejects.toThrow('Invalid Surface Execution output');
  });
});
