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
  loggerWarn: vi.fn(),
  resolve: vi.fn(),
  hasInteractiveUi: vi.fn(() => true),
}));

vi.mock('../../../src/host/memory/directiveMemoryConfirmation', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../../src/host/memory/directiveMemoryConfirmation')>(),
  requestDirectiveMemoryConfirmation: mocks.confirmation,
}));

vi.mock('../../../src/host/platform/windowBridge', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../../src/host/platform/windowBridge')>(),
  hasInteractiveUi: mocks.hasInteractiveUi,
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
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: mocks.loggerWarn, error: vi.fn() }),
}));

const { ToolExecutor } = await import('../../../src/host/tools/toolExecutor');
const { getToolResolver, resetToolResolver } = await import('../../../src/host/tools/dispatch/toolResolver');
const { resolveToolWriteTargets } = await import('../../../src/host/tools/writeTargets');
const { webSearchSchema } = await import('../../../src/host/tools/modules/network/webSearch.schema');
const { screenshotPageSchema } = await import('../../../src/host/tools/modules/network/screenshotPage.schema');
const { DIRECTIVE_MEMORY_HEADLESS_NO_UI_ERROR } = await import('../../../src/host/memory/directiveMemoryMessages');
const { HEADLESS_PERMISSION_PROBE_TIMEOUT_MS } = await import('../../../src/host/memory/directiveMemoryConfirmation');
const { getDecisionHistory } = await import('../../../src/host/security/decisionHistory');
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
  {
    name: 'notebook_edit',
    description: 'edit notebook',
    inputSchema: {
      type: 'object',
      properties: {
        notebook_path: { type: 'string' },
        cell_id: { type: 'number' },
        new_source: { type: 'string' },
      },
      required: ['notebook_path', 'cell_id', 'new_source'],
    },
    category: 'fs',
    permissionLevel: 'write',
    pathAuthority: [{ kind: 'path', pathParameter: 'notebook_path', mutation: 'edit' }],
  },
  {
    name: 'ArtifactGenerator',
    description: 'generate artifact',
    inputSchema: {
      type: 'object',
      properties: {
        output_path: { type: 'string' },
        content: { type: 'string' },
        overwrite: { type: 'boolean' },
      },
      required: ['output_path', 'content'],
    },
    category: 'fs',
    permissionLevel: 'write',
    pathAuthority: [{ kind: 'path', pathParameter: 'output_path', mutation: 'overwrite' }],
  },
  webSearchSchema,
  screenshotPageSchema,
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
    mocks.hasInteractiveUi.mockReset().mockReturnValue(true);
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

describe('ToolExecutor directive memory — headless（无交互界面）策略', () => {
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
    mocks.hasInteractiveUi.mockReset().mockReturnValue(false);
  });

  afterEach(() => {
    if (originalDataDir === undefined) delete process.env.CODE_AGENT_DATA_DIR;
    else process.env.CODE_AGENT_DATA_DIR = originalDataDir;
  });

  it('非 skip：fail-fast 立即拒绝，不进 120s 确认窗、不派发执行', async () => {
    const start = Date.now();
    const executor = new ToolExecutor({
      workingDirectory: '/tmp',
      requestPermission: vi.fn(async () => ({ approved: false, denialSource: 'no-approval-ui' as const })),
    });
    executor.setAuditEnabled(false);

    const result = await executor.execute(
      'MemoryWrite',
      { action: 'write', filename: 'c1.md', content: 'directive' },
      { preApprovedTools: new Set(['MemoryWrite']) },
    );

    expect(Date.now() - start).toBeLessThan(5_000);
    expect(result.success).toBe(false);
    expect(result.error).toBe(DIRECTIVE_MEMORY_HEADLESS_NO_UI_ERROR);
    expect(result.error).toContain('不要重试');
    expect(result.metadata).toMatchObject({ code: 'DIRECTIVE_MEMORY_CONFIRMATION_REQUIRED' });
    // 关键：headless 下绝不触碰 120s 确认窗
    expect(mocks.confirmation).not.toHaveBeenCalled();
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it('skip（requestPermission 批准）：放行写入、合成授权、写 permission ledger', async () => {
    const history = getDecisionHistory();
    history.clear();
    const executor = new ToolExecutor({
      workingDirectory: '/tmp',
      requestPermission: vi.fn(async () => true),
    });
    executor.setAuditEnabled(false);
    mocks.execute.mockImplementation(async () => ({ ok: true, output: 'written' }));

    const result = await executor.execute(
      'Bash',
      { command: `printf directive > ${path.join(memoryDir, 'c1.md')}` },
      { preApprovedTools: new Set(['Bash']), sessionId: 'headless-skip-test' },
    );

    expect(result).toMatchObject({ success: true, output: 'written' });
    expect(mocks.execute).toHaveBeenCalledOnce();
    expect(mocks.confirmation).not.toHaveBeenCalled();
    // permission ledger：skip 放行全局记忆写入必须留痕
    expect(history.getAll().some((entry) => (
      entry.outcome === 'auto-approve' && entry.reason === 'directive-memory-headless-skip-permissions'
    ))).toBe(true);
  });

  it('web 式「在等人类通道」的处理器（永不回答）：按探针上限 fail-fast，不陪等', async () => {
    vi.useFakeTimers();
    try {
      const executor = new ToolExecutor({
        workingDirectory: '/tmp',
        // 模拟 web 停车审批/无 UI 超时定时器：永远不会自己 resolve
        requestPermission: vi.fn(() => new Promise<boolean>(() => {})),
      });
      executor.setAuditEnabled(false);

      const pending = executor.execute(
        'MemoryWrite',
        { action: 'write', filename: 'c1.md', content: 'directive' },
        { preApprovedTools: new Set(['MemoryWrite']) },
      );
      await vi.advanceTimersByTimeAsync(HEADLESS_PERMISSION_PROBE_TIMEOUT_MS);
      const result = await pending;

      expect(result.success).toBe(false);
      expect(result.error).toBe(DIRECTIVE_MEMORY_HEADLESS_NO_UI_ERROR);
      expect(mocks.confirmation).not.toHaveBeenCalled();
      expect(mocks.execute).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
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
    mocks.execute.mockImplementation(async (params: Record<string, unknown>) => {
      await fs.writeFile(params.file_path as string, params.content as string, 'utf8');
      return { ok: true, output: 'written' };
    });
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
    expect(second.error).toContain('Wait for it to finish');
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

  it('rejects a second live sibling after the first tool call releases its file lock', async () => {
    const scope = nextScope();
    const filePath = path.join(tmpDir, 'sequential-claim.txt');
    mocks.execute.mockImplementation(async (params: Record<string, unknown>) => {
      await fs.writeFile(params.file_path as string, params.content as string, 'utf8');
      return { ok: true, output: 'written' };
    });
    const executor = new ToolExecutor({ workingDirectory: tmpDir, requestPermission: vi.fn(async () => true) });
    executor.setAuditEnabled(false);

    expect((await executeWrite(executor, scope, 'agent-a', filePath, 'from-a')).success).toBe(true);
    const sibling = await executeWrite(executor, scope, 'agent-b', filePath, 'from-b');
    expect(sibling.metadata?.code).toBe('WRITE_OWNERSHIP_CONFLICT');
    expect(await fs.readFile(filePath, 'utf8')).toBe('from-a');

    getFileOwnershipRegistry().release(actor(scope, 'agent-a'));
    getFileOwnershipRegistry().release(actor(scope, 'agent-b'));
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

describe('ToolExecutor path mutation guard', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'path-mutation-guard-'));
    tmpDir = await fs.realpath(tmpDir);
    resetToolResolver();
    mocks.getSchemas.mockReturnValue(schemas);
    mocks.has.mockReturnValue(true);
    mocks.resolve.mockResolvedValue({ execute: mocks.execute });
    mocks.execute.mockReset();
    mocks.loggerWarn.mockReset();
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('serializes different sessions through the real executor so notebook edits do not lose updates', async () => {
    const notebookPath = path.join(tmpDir, 'shared.ipynb');
    const firstWorkspace = path.join(tmpDir, 'workspace-a');
    const secondWorkspace = path.join(tmpDir, 'workspace-b');
    await Promise.all([
      fs.mkdir(firstWorkspace),
      fs.mkdir(secondWorkspace),
    ]);
    await fs.writeFile(notebookPath, JSON.stringify({
      cells: [{ source: ['base-0'] }, { source: ['base-1'] }],
    }), 'utf8');

    let releaseFirst!: () => void;
    let markFirstEntered!: () => void;
    let markSecondEntered!: () => void;
    const firstEntered = new Promise<void>((resolve) => { markFirstEntered = resolve; });
    const secondEntered = new Promise<void>((resolve) => { markSecondEntered = resolve; });
    const firstBlocked = new Promise<void>((resolve) => { releaseFirst = resolve; });
    mocks.execute.mockImplementation(async (params: Record<string, unknown>) => {
      const notebook = JSON.parse(await fs.readFile(params.notebook_path as string, 'utf8')) as {
        cells: Array<{ source: string[] }>;
      };
      if (params.new_source === 'first') {
        markFirstEntered();
        await firstBlocked;
      } else {
        markSecondEntered();
      }
      notebook.cells[params.cell_id as number].source = [params.new_source as string];
      await fs.writeFile(params.notebook_path as string, JSON.stringify(notebook), 'utf8');
      return { ok: true, output: 'edited' };
    });
    const firstExecutor = new ToolExecutor({ workingDirectory: firstWorkspace, requestPermission: vi.fn(async () => true) });
    const secondExecutor = new ToolExecutor({ workingDirectory: secondWorkspace, requestPermission: vi.fn(async () => true) });
    firstExecutor.setAuditEnabled(false);
    secondExecutor.setAuditEnabled(false);

    const first = firstExecutor.execute('notebook_edit', {
      notebook_path: notebookPath,
      cell_id: 0,
      new_source: 'first',
    }, {
      preApprovedTools: new Set(['notebook_edit']),
      sessionId: 'mutation-session-a',
      agentId: 'agent-a',
    });
    await firstEntered;
    const second = secondExecutor.execute('notebook_edit', {
      notebook_path: notebookPath,
      cell_id: 1,
      new_source: 'second',
    }, {
      preApprovedTools: new Set(['notebook_edit']),
      sessionId: 'mutation-session-b',
      agentId: 'agent-b',
    });

    const enteredBeforeRelease = await Promise.race([
      secondEntered.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 50)),
    ]);
    expect(enteredBeforeRelease).toBe(false);
    releaseFirst();
    expect((await first).success).toBe(true);
    expect((await second).success).toBe(true);
    const notebook = JSON.parse(await fs.readFile(notebookPath, 'utf8')) as {
      cells: Array<{ source: string[] }>;
    };
    expect(notebook.cells.map((cell) => cell.source)).toEqual([['first'], ['second']]);
  });

  it('preserves an existing artifact unless overwrite=true and audits explicit replacement', async () => {
    const outputPath = path.join(tmpDir, 'artifact.bin');
    const original = Buffer.from([0, 1, 2, 3, 255]);
    await fs.writeFile(outputPath, original);
    mocks.execute.mockImplementation(async (params: Record<string, unknown>) => {
      await fs.writeFile(params.output_path as string, params.content as string, 'utf8');
      return { ok: true, output: 'generated' };
    });
    const executor = new ToolExecutor({ workingDirectory: tmpDir, requestPermission: vi.fn(async () => true) });
    executor.setAuditEnabled(false);
    const options = {
      preApprovedTools: new Set(['ArtifactGenerator']),
      sessionId: 'generator-session',
      agentId: 'generator-agent',
    };

    const refused = await executor.execute('ArtifactGenerator', {
      output_path: outputPath,
      content: 'replacement',
    }, options);
    expect(refused).toMatchObject({
      success: false,
      metadata: { code: 'TARGET_EXISTS', path: outputPath },
    });
    expect(await fs.readFile(outputPath)).toEqual(original);
    expect(mocks.execute).not.toHaveBeenCalled();

    const replaced = await executor.execute('ArtifactGenerator', {
      output_path: outputPath,
      content: 'replacement',
      overwrite: true,
    }, options);
    expect(replaced.success).toBe(true);
    expect(await fs.readFile(outputPath, 'utf8')).toBe('replacement');
    expect(mocks.loggerWarn).toHaveBeenCalledWith(
      'Tool target overwrite safety explicitly confirmed',
      expect.objectContaining({
        action: 'tool_target_overwrite',
        toolName: 'ArtifactGenerator',
        path: outputPath,
      }),
    );
  });

  it.each([
    ['WebSearch', { query: 'safe mutation guard', save_to: 'search.md' }, 'search.md'],
    ['screenshot_page', { url: 'https://example.com', output_path: 'page.png' }, 'page.png'],
  ])('guards the real %s schema output and no longer declares it read-only', async (toolName, params, fileName) => {
    const outputPath = path.join(tmpDir, fileName);
    const absoluteParams = toolName === 'WebSearch'
      ? { ...params, save_to: outputPath }
      : { ...params, output_path: outputPath };
    await fs.writeFile(outputPath, 'original', 'utf8');
    mocks.execute.mockImplementation(async (callParams: Record<string, unknown>) => {
      const target = (callParams.save_to ?? callParams.output_path) as string;
      await fs.writeFile(target, 'replacement', 'utf8');
      return { ok: true, output: 'written' };
    });
    const executor = new ToolExecutor({ workingDirectory: tmpDir, requestPermission: vi.fn(async () => true) });
    executor.setAuditEnabled(false);

    const result = await executor.execute(toolName, absoluteParams, {
      preApprovedTools: new Set([toolName]),
      sessionId: `${toolName}-session`,
      agentId: `${toolName}-agent`,
    });

    expect(result).toMatchObject({
      success: false,
      metadata: { code: 'TARGET_EXISTS', path: outputPath },
    });
    expect(await fs.readFile(outputPath, 'utf8')).toBe('original');
    expect(mocks.execute).not.toHaveBeenCalled();
    expect(toolName === 'WebSearch' ? webSearchSchema.readOnly : screenshotPageSchema.readOnly).toBe(false);

    const replaced = await executor.execute(toolName, { ...absoluteParams, overwrite: true }, {
      preApprovedTools: new Set([toolName]),
      sessionId: `${toolName}-session`,
      agentId: `${toolName}-agent`,
    });
    expect(replaced.success).toBe(true);
    expect(await fs.readFile(outputPath, 'utf8')).toBe('replacement');
  });

  it('keeps read-only actions as conservative generic targets without a mutation kind', async () => {
    const { excelAutomateSchema } = await import('../../../src/host/tools/modules/excel/excelAutomate.schema');
    const { pptEditSchema } = await import('../../../src/host/tools/modules/network/pptEdit.schema');
    const workbookPath = path.join(tmpDir, 'book.xlsx');
    const slidePath = path.join(tmpDir, 'slides.pptx');

    expect(resolveToolWriteTargets({
      definition: {
        name: excelAutomateSchema.name,
        description: excelAutomateSchema.description,
        inputSchema: excelAutomateSchema.inputSchema,
        outputSchema: excelAutomateSchema.outputSchema,
        permissionLevel: 'write',
        requiresPermission: true,
        pathAuthority: excelAutomateSchema.pathAuthority,
      },
      params: { action: 'read', file_path: workbookPath },
      workingDirectory: tmpDir,
    })).toMatchObject({ targets: [workbookPath], mutations: {} });
    expect(resolveToolWriteTargets({
      definition: {
        name: excelAutomateSchema.name,
        description: excelAutomateSchema.description,
        inputSchema: excelAutomateSchema.inputSchema,
        outputSchema: excelAutomateSchema.outputSchema,
        permissionLevel: 'write',
        requiresPermission: true,
        pathAuthority: excelAutomateSchema.pathAuthority,
      },
      params: { action: 'edit', file_path: workbookPath },
      workingDirectory: tmpDir,
    })).toMatchObject({ targets: [workbookPath], mutations: { [workbookPath]: 'edit' } });
    expect(resolveToolWriteTargets({
      definition: {
        name: pptEditSchema.name,
        description: pptEditSchema.description,
        inputSchema: pptEditSchema.inputSchema,
        outputSchema: pptEditSchema.outputSchema,
        permissionLevel: 'write',
        requiresPermission: true,
        pathAuthority: pptEditSchema.pathAuthority,
      },
      params: { action: 'extract_style', file_path: slidePath },
      workingDirectory: tmpDir,
    })).toMatchObject({ targets: [slidePath], mutations: {} });
  });
});
