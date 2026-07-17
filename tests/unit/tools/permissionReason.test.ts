import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PermissionRequestReason,
  permissionReasonText,
} from '../../../src/shared/contract/permission';
import type { PermissionRequestData } from '../../../src/host/tools/types';

// 复用 toolExecutor.permissionBoundary.test.ts 的 mock 套路：
// 通过 requestPermission spy 捕获 buildPermissionRequest 产出的 request 对象。
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
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

const { ToolExecutor } = await import('../../../src/host/tools/toolExecutor');

describe('permissionReasonText 枚举文案映射', () => {
  it('每个枚举值都映射到非空、互不相同的文案（无 default 漏网）', () => {
    const codes = Object.values(PermissionRequestReason);
    const texts = codes.map((code) => permissionReasonText(code));

    // 全部非空
    for (const text of texts) {
      expect(typeof text).toBe('string');
      expect(text.length).toBeGreaterThan(0);
    }
    // 互不相同（确认没有两个码意外落到同一文案）
    expect(new Set(texts).size).toBe(codes.length);
    // 锁定枚举规模，未来新增值会让此断言提示同步补文案 + 分类
    expect(codes.length).toBe(5);
  });
});

describe('ToolExecutor buildPermissionRequest reasonCode 分类', () => {
  const definitions = new Map<string, unknown>([
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
    ['WebFetch', {
      name: 'WebFetch',
      description: 'web fetch test tool',
      inputSchema: { type: 'object', properties: {}, required: [] },
      requiresPermission: true,
      permissionLevel: 'network',
    }],
    ['CustomTool', {
      name: 'CustomTool',
      description: 'unmatched custom tool (exercises default branch)',
      inputSchema: { type: 'object', properties: {}, required: [] },
      requiresPermission: true,
      permissionLevel: 'write',
    }],
  ]);

  beforeEach(() => {
    resolverState.getDefinition.mockReset();
    resolverState.getDefinition.mockImplementation((name: string) => definitions.get(name));
    resolverState.execute.mockReset();
    resolverState.execute.mockResolvedValue({ success: true, output: 'ok' });
  });

  function makeExecutor(requestPermission: (request: PermissionRequestData) => Promise<boolean>) {
    const executor = new ToolExecutor({
      requestPermission,
      workingDirectory: '/tmp/workbench',
    });
    executor.setAuditEnabled(false);
    return executor;
  }

  // 用 skillToolBoundary 排除目标工具，强制走用户确认分支（否则安全命令/只读网络/
  // 工作区内写会被分类器自动批准、不触发 requestPermission）。该 boundary 不影响
  // reasonCode —— reasonCode 仅由工具名 + 路径在 buildPermissionRequest 中推导。
  const forceConfirm = {
    sessionId: 's1',
    skillToolBoundary: { skillName: 'test-skill', allowedTools: ['Read'] },
  };

  it('Bash 命令 → ShellHighRisk', async () => {
    const requestPermission = vi.fn(async () => true);
    await makeExecutor(requestPermission).execute('Bash', { command: 'ls -la' }, forceConfirm);
    expect(requestPermission).toHaveBeenCalledWith(expect.objectContaining({
      reasonCode: PermissionRequestReason.ShellHighRisk,
    }));
  });

  it('写工作区外文件 → FileWriteOutsideWorkspace', async () => {
    const requestPermission = vi.fn(async () => true);
    await makeExecutor(requestPermission).execute(
      'Write',
      { file_path: '/Users/linchen/Desktop/out.txt', content: 'x' },
      forceConfirm
    );
    expect(requestPermission).toHaveBeenCalledWith(expect.objectContaining({
      reasonCode: PermissionRequestReason.FileWriteOutsideWorkspace,
    }));
  });

  it('写工作区内文件 → reasonCode 不误标为“工作区外”（undefined）', async () => {
    const requestPermission = vi.fn<(request: PermissionRequestData) => Promise<boolean>>(async () => true);
    await makeExecutor(requestPermission).execute(
      'Write',
      { file_path: 'src/app.ts', content: 'x' },
      forceConfirm
    );
    expect(requestPermission).toHaveBeenCalled();
    const call = requestPermission.mock.calls[0]?.[0] as { reasonCode?: unknown };
    expect(call.reasonCode).toBeUndefined();
  });

  it('MCP 调用 → McpTool', async () => {
    const requestPermission = vi.fn(async () => true);
    await makeExecutor(requestPermission).execute(
      'MCPUnified',
      { server: 'github', tool: 'search_code', query: 'x' },
      forceConfirm
    );
    expect(requestPermission).toHaveBeenCalledWith(expect.objectContaining({
      reasonCode: PermissionRequestReason.McpTool,
    }));
  });

  it('Web 网络访问 → NetworkEgress', async () => {
    const requestPermission = vi.fn(async () => true);
    await makeExecutor(requestPermission).execute(
      'WebFetch',
      { url: 'https://example.com' },
      forceConfirm
    );
    expect(requestPermission).toHaveBeenCalledWith(expect.objectContaining({
      reasonCode: PermissionRequestReason.NetworkEgress,
    }));
  });

  it('未匹配的工具（default 分支）→ Unknown，不留空白原因', async () => {
    const requestPermission = vi.fn(async () => true);
    await makeExecutor(requestPermission).execute('CustomTool', { foo: 'bar' }, forceConfirm);
    expect(requestPermission).toHaveBeenCalledWith(expect.objectContaining({
      reasonCode: PermissionRequestReason.Unknown,
    }));
  });
});
