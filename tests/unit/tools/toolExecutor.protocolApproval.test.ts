import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  handlerExecute: vi.fn(),
  getSchemas: vi.fn(),
  has: vi.fn(),
  resolve: vi.fn(),
}));

vi.mock('../../../src/main/tools/protocolRegistry', () => ({
  getProtocolRegistry: () => ({
    getSchemas: mocks.getSchemas,
    has: mocks.has,
    resolve: mocks.resolve,
  }),
  isProtocolToolName: vi.fn(() => false),
  resetProtocolRegistry: vi.fn(),
}));

vi.mock('../../../src/main/services/cloud', () => ({
  getCloudConfigService: () => ({
    getAllToolMeta: () => ({}),
  }),
}));

vi.mock('../../../src/main/mcp', () => ({
  getMCPClient: () => ({
    getToolDefinitions: () => [],
    parseMCPToolName: () => null,
  }),
}));

vi.mock('../../../src/main/services/infra/toolCache', () => ({
  getToolCache: () => ({
    isCacheable: () => false,
    get: () => null,
    set: vi.fn(),
  }),
}));

vi.mock('../../../src/main/tools/middleware/fileCheckpointMiddleware', () => ({
  createFileCheckpointIfNeeded: vi.fn(),
}));

vi.mock('../../../src/main/services/infra/logger', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

const { ToolExecutor } = await import('../../../src/main/tools/toolExecutor');
const { resetToolResolver } = await import('../../../src/main/tools/dispatch/toolResolver');

describe('ToolExecutor protocol approval reuse', () => {
  beforeEach(() => {
    resetToolResolver();
    mocks.getSchemas.mockReturnValue([
      {
        name: 'Bash',
        description: 'Execute shell command',
        inputSchema: {
          type: 'object',
          properties: { command: { type: 'string' } },
          required: ['command'],
        },
        category: 'shell',
        permissionLevel: 'execute',
      },
    ]);
    mocks.has.mockImplementation((name: string) => name === 'Bash');
    mocks.handlerExecute.mockReset();
    mocks.handlerExecute.mockImplementation(async (args, _ctx, canUseTool) => {
      const permission = await canUseTool('Bash', args);
      return permission.allow
        ? { ok: true, output: 'ok' }
        : { ok: false, error: permission.reason };
    });
    mocks.resolve.mockResolvedValue({
      execute: mocks.handlerExecute,
    });
  });

  it('does not ask twice when a safe Bash call reaches a native handler', async () => {
    const requestPermission = vi.fn(async () => true);
    const executor = new ToolExecutor({
      workingDirectory: '/tmp',
      requestPermission,
    });
    executor.setAuditEnabled(false);

    const result = await executor.execute('Bash', { command: 'git status' }, {});

    expect(result).toMatchObject({ success: true, output: 'ok' });
    expect(requestPermission).not.toHaveBeenCalled();
    expect(mocks.handlerExecute).toHaveBeenCalledOnce();
  });
});
