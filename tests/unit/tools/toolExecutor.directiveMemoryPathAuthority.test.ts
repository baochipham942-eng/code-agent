import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import type { SwarmRunScope } from '../../../src/shared/contract/swarm';

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
const {
  createFileOwnershipActor,
  getFileOwnershipRegistry,
} = await import('../../../src/host/services/infra/fileOwnershipRegistry');

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

describe('ToolExecutor file ownership authority', () => {
  let tmpDir: string;
  let sequence = 0;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'single-writer-executor-'));
    resetToolResolver();
    mocks.getSchemas.mockReturnValue(schemas);
    mocks.has.mockReturnValue(true);
    mocks.resolve.mockResolvedValue({ execute: mocks.execute });
    mocks.execute.mockReset();
    mocks.confirmation.mockReset();
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  function nextScope(): SwarmRunScope {
    sequence += 1;
    return { sessionId: `single-writer-session-${sequence}`, runId: `run-${sequence}`, treeId: `tree-${sequence}` };
  }

  function actor(scope: SwarmRunScope, agentId: string) {
    const result = createFileOwnershipActor({
      sessionId: scope.sessionId,
      agentId,
      swarmRunScope: scope,
      workingDirectory: tmpDir,
    });
    if (!result) throw new Error('expected ownership actor');
    return result;
  }

  function executeWrite(
    executor: InstanceType<typeof ToolExecutor>,
    scope: SwarmRunScope,
    agentId: string,
    filePath: string,
    content: string,
  ) {
    return executor.execute('Write', { file_path: filePath, content }, {
      preApprovedTools: new Set(['Write']),
      sessionId: scope.sessionId,
      agentId,
      swarmRunScope: scope,
      spawnDepth: 1,
    });
  }

  it('allows exactly one live sibling through the real executor path for one target', async () => {
    const scope = nextScope();
    const filePath = path.join(tmpDir, 'shared.txt');
    const canonicalPath = path.join(await fs.realpath(tmpDir), 'shared.txt');
    let unblockFirst!: () => void;
    let markEntered!: () => void;
    const entered = new Promise<void>((resolve) => { markEntered = resolve; });
    const blocked = new Promise<void>((resolve) => { unblockFirst = resolve; });
    mocks.execute.mockImplementationOnce(async (params: Record<string, unknown>) => {
      markEntered();
      await blocked;
      await fs.writeFile(params.file_path as string, params.content as string, 'utf8');
      return { ok: true, output: 'written' };
    });
    const executor = new ToolExecutor({ workingDirectory: tmpDir, requestPermission: vi.fn(async () => true) });
    executor.setAuditEnabled(false);

    const first = executeWrite(executor, scope, 'agent-a', filePath, 'from-a');
    await entered;
    const second = await executeWrite(executor, scope, 'agent-b', filePath, 'from-b');
    unblockFirst();
    const firstResult = await first;

    expect(firstResult).toMatchObject({ success: true });
    expect(second).toMatchObject({
      success: false,
      metadata: {
        code: 'WRITE_OWNERSHIP_CONFLICT',
        path: canonicalPath,
        ownerAgentId: 'agent-a',
        requesterAgentId: 'agent-b',
      },
    });
    expect(second.error).toContain('等待它完成后再写');
    expect(await fs.readFile(filePath, 'utf8')).toBe('from-a');
    const snapshot = getFileOwnershipRegistry().snapshot(scope);
    expect(snapshot.conflicts).toHaveLength(1);
    expect(snapshot.actors.filter((entry) => entry.claimed.includes(canonicalPath))).toHaveLength(1);

    getFileOwnershipRegistry().release(actor(scope, 'agent-a'));
    getFileOwnershipRegistry().release(actor(scope, 'agent-b'));
  });

  it('keeps disjoint declarations collaborative and idempotent', async () => {
    const scope = nextScope();
    const firstPath = path.join(tmpDir, 'a.txt');
    const secondPath = path.join(tmpDir, 'b.txt');
    const firstActor = actor(scope, 'agent-a');
    const secondActor = actor(scope, 'agent-b');
    const registry = getFileOwnershipRegistry();
    registry.declare(firstActor, ['a.txt']);
    registry.declare(firstActor, ['a.txt']);
    registry.declare(secondActor, ['b.txt']);
    mocks.execute.mockImplementation(async (params: Record<string, unknown>) => {
      await fs.writeFile(params.file_path as string, params.content as string, 'utf8');
      return { ok: true, output: 'written' };
    });
    const executor = new ToolExecutor({ workingDirectory: tmpDir, requestPermission: vi.fn(async () => true) });
    executor.setAuditEnabled(false);

    const results = await Promise.all([
      executeWrite(executor, scope, 'agent-a', firstPath, 'a'),
      executeWrite(executor, scope, 'agent-b', secondPath, 'b'),
    ]);
    expect(results.every((result) => result.success)).toBe(true);
    const beforeRetry = registry.snapshot(scope);
    expect((await executeWrite(executor, scope, 'agent-a', firstPath, 'a2')).success).toBe(true);
    const afterRetry = registry.snapshot(scope);
    expect(afterRetry).toEqual(beforeRetry);
    expect(await fs.readFile(firstPath, 'utf8')).toBe('a2');
    expect(await fs.readFile(secondPath, 'utf8')).toBe('b');
    for (const entry of afterRetry.actors) {
      for (const claimed of entry.claimed) {
        expect(await fs.readFile(claimed, 'utf8')).toBe(entry.agentId === 'agent-a' ? 'a2' : 'b');
      }
    }

    registry.release(firstActor);
    registry.release(secondActor);
  });

  it('deduplicates the same conflict when a write action is retried', async () => {
    const scope = nextScope();
    const filePath = path.join(tmpDir, 'conflict.txt');
    const registry = getFileOwnershipRegistry();
    const owner = actor(scope, 'agent-a');
    const requester = actor(scope, 'agent-b');
    registry.declare(owner, [filePath]);
    const executor = new ToolExecutor({ workingDirectory: tmpDir, requestPermission: vi.fn(async () => true) });
    executor.setAuditEnabled(false);

    const first = await executeWrite(executor, scope, 'agent-b', filePath, 'blocked');
    const afterFirst = registry.snapshot(scope);
    const second = await executeWrite(executor, scope, 'agent-b', filePath, 'blocked');
    expect(first.metadata?.code).toBe('WRITE_OWNERSHIP_CONFLICT');
    expect(second.metadata?.code).toBe('WRITE_OWNERSHIP_CONFLICT');
    expect(registry.snapshot(scope)).toEqual(afterFirst);
    expect(afterFirst.conflicts).toHaveLength(1);
    expect(mocks.execute).not.toHaveBeenCalled();

    registry.release(owner);
    registry.release(requester);
  });
});
