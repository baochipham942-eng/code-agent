import { beforeEach, describe, expect, it, vi } from 'vitest';

const resolverState = vi.hoisted(() => ({
  getDefinition: vi.fn(),
  execute: vi.fn(),
}));

vi.mock('../../../src/host/tools/dispatch/toolResolver', () => ({
  getToolResolver: () => ({
    getDefinition: resolverState.getDefinition,
    execute: resolverState.execute,
  }),
}));

vi.mock('../../../src/host/services/infra/toolCache', () => ({
  getToolCache: () => ({
    isCacheable: () => false,
    get: () => null,
    set: vi.fn(),
  }),
}));

vi.mock('../../../src/host/tools/middleware/fileCheckpointMiddleware', () => ({
  createFileCheckpointIfNeeded: vi.fn(),
}));

vi.mock('../../../src/host/agent/confirmationGate', () => ({
  getConfirmationGate: () => ({
    buildPreview: () => null,
    assessRiskLevel: () => 'low',
    shouldConfirm: () => false,
  }),
}));

vi.mock('../../../src/host/security/writeIsolation', () => ({
  getWriteIsolationManager: () => ({
    acquire: vi.fn(async () => () => {}),
  }),
  getWriteIsolationScope: () => null,
}));

vi.mock('../../../src/host/services/infra/logger', () => ({
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

const { ToolExecutor } = await import('../../../src/host/tools/toolExecutor');

describe('ToolExecutor permission boundary metadata', () => {
  const definitions = new Map([
    ['Write', {
      name: 'Write',
      description: 'write test tool',
      inputSchema: { type: 'object', properties: {}, required: [] },
      requiresPermission: true,
      permissionLevel: 'write',
    }],
    ['Bash', {
      name: 'Bash',
      description: 'shell test tool',
      inputSchema: { type: 'object', properties: {}, required: ['command'] },
      requiresPermission: true,
      permissionLevel: 'execute',
    }],
    ['MCPUnified', {
      name: 'MCPUnified',
      description: 'mcp test tool',
      inputSchema: { type: 'object', properties: {}, required: [] },
      requiresPermission: true,
      permissionLevel: 'network',
    }],
  ]);

  beforeEach(() => {
    resolverState.getDefinition.mockReset();
    resolverState.getDefinition.mockImplementation((name: string) => definitions.get(name));
    resolverState.execute.mockReset();
    resolverState.execute.mockResolvedValue({ success: true, output: 'ok' });
  });

  it('attaches project file boundaries to forced-confirm write requests', async () => {
    const requestPermission = vi.fn(async () => true);
    const executor = new ToolExecutor({
      requestPermission,
      workingDirectory: '/tmp/workbench',
    });
    executor.setAuditEnabled(false);

    await executor.execute('Write', { file_path: 'src/app.ts', content: 'x' }, {
      sessionId: 's1',
      skillToolBoundary: {
        skillName: 'test-skill',
        allowedTools: ['Read'],
      },
    });

    expect(requestPermission).toHaveBeenCalledWith(expect.objectContaining({
      type: 'file_write',
      boundary: {
        id: 'file.project_write',
        reason: '写入文件内容会修改目标路径。',
      },
      details: expect.objectContaining({
        path: 'src/app.ts',
        contentLength: 1,
      }),
      sessionId: 's1',
    }));
  });

  it('attaches external file boundaries to outside-workspace writes', async () => {
    const requestPermission = vi.fn(async () => true);
    const executor = new ToolExecutor({
      requestPermission,
      workingDirectory: '/tmp/workbench',
    });
    executor.setAuditEnabled(false);

    await executor.execute('Write', { file_path: '/Users/linchen/Desktop/out.txt', content: 'secret' }, {
      sessionId: 's1',
    });

    expect(requestPermission).toHaveBeenCalledWith(expect.objectContaining({
      type: 'file_write',
      boundary: expect.objectContaining({
        id: 'file.external_write',
      }),
      details: expect.objectContaining({
        path: '/Users/linchen/Desktop/out.txt',
        contentLength: 6,
      }),
    }));
  });

  it('attaches shell boundaries to command permission requests', async () => {
    const requestPermission = vi.fn(async () => true);
    const executor = new ToolExecutor({
      requestPermission,
      workingDirectory: '/tmp/workbench',
    });
    executor.setAuditEnabled(false);

    await executor.execute('Bash', { command: 'npm install left-pad' }, {
      sessionId: 's1',
      skillToolBoundary: {
        skillName: 'test-skill',
        allowedTools: ['Read'],
      },
    });

    expect(requestPermission).toHaveBeenCalledWith(expect.objectContaining({
      type: 'command',
      boundary: {
        id: 'command.shell',
        reason: '本次命令会在当前工作区的 shell 环境执行。',
      },
      details: { command: 'npm install left-pad' },
    }));
  });

  it('attaches MCP server boundaries and tool names to MCP requests', async () => {
    const requestPermission = vi.fn(async () => true);
    const executor = new ToolExecutor({
      requestPermission,
      workingDirectory: '/tmp/workbench',
    });
    executor.setAuditEnabled(false);

    await executor.execute('MCPUnified', {
      server: 'github',
      tool: 'search_code',
      query: 'repo:example test',
    }, {
      sessionId: 's1',
    });

    expect(requestPermission).toHaveBeenCalledWith(expect.objectContaining({
      type: 'network',
      reason: '调用 MCP 服务器 github',
      boundary: {
        id: 'mcp.server_tool',
        reason: '调用 MCP 服务器 github',
      },
      details: expect.objectContaining({
        server: 'github',
        tool: 'search_code',
        toolName: 'search_code',
      }),
    }));
  });
});
