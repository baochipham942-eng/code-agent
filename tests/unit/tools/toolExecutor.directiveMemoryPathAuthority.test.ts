import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as path from 'node:path';

const mocks = vi.hoisted(() => ({
  confirmation: vi.fn(),
  execute: vi.fn(),
  getSchemas: vi.fn(),
  has: vi.fn(),
  resolve: vi.fn(),
}));

vi.mock('../../../src/host/memory/directiveMemoryConfirmation', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../../src/host/memory/directiveMemoryConfirmation')>(),
  requestDirectiveMemoryConfirmation: mocks.confirmation,
}));

vi.mock('../../../src/host/tools/protocolRegistry', () => ({
  getProtocolRegistry: () => ({
    getSchemas: mocks.getSchemas,
    has: mocks.has,
    resolve: mocks.resolve,
  }),
  isProtocolToolName: vi.fn(() => false),
  resetProtocolRegistry: vi.fn(),
}));

vi.mock('../../../src/host/tools/protocolToolRegistration', () => ({
  getProtocolToolSchemas: mocks.getSchemas,
  hasProtocolTool: mocks.has,
  resolveProtocolTool: mocks.resolve,
  registerProtocolTool: vi.fn(),
  unregisterProtocolTool: vi.fn(),
  setProtocolToolRegistryPort: vi.fn(),
}));

vi.mock('../../../src/host/services/cloud', () => ({
  getCloudConfigService: () => ({ getAllToolMeta: () => ({}) }),
}));

vi.mock('../../../src/host/mcp', () => ({
  getMCPClient: () => ({
    getToolDefinitions: () => [],
    parseMCPToolName: () => null,
  }),
}));

vi.mock('../../../src/host/services/infra/toolCache', () => ({
  getToolCache: () => ({
    isCacheable: () => false,
    get: () => null,
    set: vi.fn(),
    invalidateForPath: vi.fn(),
    invalidateForWorkspace: vi.fn(),
  }),
}));

vi.mock('../../../src/host/tools/middleware/fileCheckpointMiddleware', () => ({
  createFileCheckpointIfNeeded: vi.fn(),
}));

vi.mock('../../../src/host/services/infra/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

const { ToolExecutor } = await import('../../../src/host/tools/toolExecutor');
const { getToolResolver, resetToolResolver } = await import('../../../src/host/tools/dispatch/toolResolver');

const schemas = [
  {
    name: 'MemoryWrite',
    description: 'write memory',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string' },
        filename: { type: 'string' },
        content: { type: 'string' },
      },
      required: ['action', 'filename'],
    },
    category: 'fs',
    permissionLevel: 'write',
    pathAuthority: [{ kind: 'global-memory', pathParameter: 'filename' }],
  },
  {
    name: 'Write',
    description: 'write file',
    inputSchema: {
      type: 'object',
      properties: { file_path: { type: 'string' }, content: { type: 'string' } },
      required: ['file_path', 'content'],
    },
    category: 'fs',
    permissionLevel: 'write',
    pathAuthority: [{ kind: 'path', pathParameter: 'file_path' }],
  },
  {
    name: 'Bash',
    description: 'execute shell',
    inputSchema: {
      type: 'object',
      properties: { command: { type: 'string' } },
      required: ['command'],
    },
    category: 'shell',
    permissionLevel: 'execute',
    pathAuthority: [{ kind: 'shell', commandParameter: 'command' }],
  },
  {
    name: 'FutureArtifactWriter',
    description: 'future path writer',
    inputSchema: {
      type: 'object',
      properties: { destination: { type: 'string' } },
      required: ['destination'],
    },
    category: 'fs',
    permissionLevel: 'write',
  },
] as const;

describe('ToolExecutor directive memory path authority', () => {
  const originalDataDir = process.env.CODE_AGENT_DATA_DIR;
  const dataDir = '/tmp/code-agent-directive-authority';
  const memoryDir = path.join(dataDir, 'memory');

  beforeEach(() => {
    process.env.CODE_AGENT_DATA_DIR = dataDir;
    resetToolResolver();
    mocks.getSchemas.mockReturnValue(schemas);
    mocks.has.mockReturnValue(true);
    mocks.execute.mockReset().mockResolvedValue({ ok: true, output: 'written' });
    mocks.resolve.mockResolvedValue({ execute: mocks.execute });
    mocks.confirmation.mockReset();
  });

  afterEach(() => {
    if (originalDataDir === undefined) delete process.env.CODE_AGENT_DATA_DIR;
    else process.env.CODE_AGENT_DATA_DIR = originalDataDir;
  });

  const cases = [
    ['MemoryWrite direct', 'MemoryWrite', { action: 'write', filename: 'c1.md', content: 'directive' }],
    ['Write direct', 'Write', { file_path: path.join(memoryDir, 'c1.md'), content: 'directive' }],
    ['Bash redirect', 'Bash', { command: `printf directive > ${path.join(memoryDir, 'c1.md')}` }],
    ['Bash append INDEX', 'Bash', { command: `printf entry >> ${path.join(memoryDir, 'INDEX.md')}` }],
    ['future declared writer', 'FutureArtifactWriter', { destination: path.join(memoryDir, 'future.md') }],
  ] as const;

  it.each(cases)('blocks %s before dispatch when confirmation is denied', async (_label, tool, params) => {
    mocks.confirmation.mockResolvedValueOnce({
      requestId: 'directive-denied',
      confirmed: false,
      respondedAt: Date.now(),
      timedOut: false,
    });
    const executor = new ToolExecutor({ workingDirectory: '/tmp', requestPermission: vi.fn(async () => true) });
    executor.setAuditEnabled(false);

    const result = await executor.execute(tool, params, { preApprovedTools: new Set([tool]) });

    expect(result).toMatchObject({ success: false, metadata: { code: 'DIRECTIVE_MEMORY_CONFIRMATION_REQUIRED' } });
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it.each(cases)('allows %s after explicit confirmation', async (_label, tool, params) => {
    mocks.confirmation.mockResolvedValueOnce({
      requestId: 'directive-approved',
      confirmed: true,
      respondedAt: Date.now(),
      timedOut: false,
    });
    const executor = new ToolExecutor({ workingDirectory: '/tmp', requestPermission: vi.fn(async () => true) });
    executor.setAuditEnabled(false);

    const result = await executor.execute(tool, params, { preApprovedTools: new Set([tool]) });

    expect(result).toMatchObject({ success: true, output: 'written' });
    expect(mocks.execute).toHaveBeenCalledOnce();
  });

  it('fails closed when the protocol resolver is called directly without a matching grant', async () => {
    const result = await getToolResolver().execute(
      'Write',
      { file_path: path.join(memoryDir, 'bypass.md'), content: 'directive' },
      {
        workingDirectory: '/tmp',
        requestPermission: vi.fn(async () => true),
        abortSignal: new AbortController().signal,
      },
    );

    expect(result).toMatchObject({
      success: false,
      metadata: { code: 'DIRECTIVE_MEMORY_CONFIRMATION_REQUIRED' },
    });
    expect(mocks.execute).not.toHaveBeenCalled();
  });
});
