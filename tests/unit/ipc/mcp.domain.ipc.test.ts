import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_DOMAINS, type IPCRequest, type IPCResponse } from '../../../src/shared/ipc';

// mcp.ipc.ts 派发特征测试（RQ-183 续作·MCP 刀迁表前钉住 switch 形态）：派发层 12 个 action。
// 既有 mcp.ipc.test.ts 重在 settings 草稿规范化 / 持久化 / 密钥 / addServer / setServerEnabled / removeServer / signOut 业务，
// 以及 INSTALL_IN_PROGRESS / CANCELLED 两个 code。这里补派发层契约：
// - 只读五件套 getStatus / getCatalog / listTools / listResources / getServerStates 的委派与原样回传
// - reconnectServer 透传 serverName、refreshFromCloud 调刷新并回 { success: true }
// - catch code 判定链：AbortError → CANCELLED；普通 Error → INTERNAL_ERROR；非 Error → INTERNAL_ERROR + String(error)
// - 未知 action → INVALID_ACTION + `Unknown action: <action>` 完整文案
// 迁表后本文件零改动全绿即行为不变证明。

const env = vi.hoisted(() => ({
  client: {
    getStatus: vi.fn((): unknown => ({ connected: 1 })),
    getTools: vi.fn((): unknown => [{ name: 't1' }]),
    getResources: vi.fn((): unknown => [{ uri: 'r1' }]),
    getServerStates: vi.fn((): unknown[] => []),
    reconnect: vi.fn(async (_name: string): Promise<unknown> => ({ success: true })),
  },
  refresh: vi.fn(async () => {}),
  catalog: vi.fn((): unknown => [{ id: 'cat-1' }]),
}));

vi.mock('../../../src/host/mcp/mcpClient', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/host/mcp/mcpClient')>()),
  getMCPClient: () => env.client,
  refreshMCPServersFromCloud: () => env.refresh(),
}));
vi.mock('../../../src/host/services/cloud', () => ({
  getCloudConfigService: () => ({ getMcpCatalog: () => env.catalog() }),
}));

import { registerMcpHandlers } from '../../../src/host/ipc/mcp.ipc';

type HandlerFn = (event: unknown, request: IPCRequest) => Promise<IPCResponse>;
let call: (action: string, payload?: unknown) => Promise<IPCResponse>;

beforeEach(() => {
  vi.clearAllMocks();
  env.client.getStatus.mockReturnValue({ connected: 1 });
  env.client.getTools.mockReturnValue([{ name: 't1' }]);
  env.client.getResources.mockReturnValue([{ uri: 'r1' }]);
  env.client.getServerStates.mockReturnValue([]);
  env.client.reconnect.mockResolvedValue({ success: true });
  env.catalog.mockReturnValue([{ id: 'cat-1' }]);
  const handlers = new Map<string, HandlerFn>();
  registerMcpHandlers({ handle: (ch: string, fn: HandlerFn) => handlers.set(ch, fn) } as never, {
    getWorkingDirectory: () => '/tmp/work',
  });
  const handler = handlers.get(IPC_DOMAINS.MCP)!;
  call = (action, payload) => handler(null, { action, payload } as IPCRequest);
});

describe('mcp.ipc dispatch 特征：只读委派', () => {
  it('getStatus / getCatalog / listTools / listResources / getServerStates 原样回传', async () => {
    expect(await call('getStatus')).toEqual({ success: true, data: { connected: 1 } });
    expect(await call('getCatalog')).toEqual({ success: true, data: [{ id: 'cat-1' }] });
    expect(await call('listTools')).toEqual({ success: true, data: [{ name: 't1' }] });
    expect(await call('listResources')).toEqual({ success: true, data: [{ uri: 'r1' }] });
    expect(await call('getServerStates')).toEqual({ success: true, data: [] });
    expect(env.client.getServerStates).toHaveBeenCalledTimes(1);
  });
});

describe('mcp.ipc dispatch 特征：reconnect / refresh', () => {
  it('reconnectServer 透传 serverName，回传结果', async () => {
    env.client.reconnect.mockResolvedValueOnce({ success: false, error: 'offline' });
    expect(await call('reconnectServer', { serverName: 'gh' })).toEqual({ success: true, data: { success: false, error: 'offline' } });
    expect(env.client.reconnect).toHaveBeenCalledWith('gh');
  });

  it('refreshFromCloud 调刷新并回 { success: true }', async () => {
    expect(await call('refreshFromCloud')).toEqual({ success: true, data: { success: true } });
    expect(env.refresh).toHaveBeenCalledTimes(1);
  });
});

describe('mcp.ipc dispatch 特征：兜底', () => {
  it('未知 action → INVALID_ACTION + 完整文案', async () => {
    expect(await call('bogus')).toEqual({ success: false, error: { code: 'INVALID_ACTION', message: 'Unknown action: bogus' } });
  });

  it('AbortError → CANCELLED（保留 message）', async () => {
    env.client.getStatus.mockImplementationOnce(() => { throw Object.assign(new Error('stop'), { name: 'AbortError' }); });
    expect(await call('getStatus')).toEqual({ success: false, error: { code: 'CANCELLED', message: 'stop' } });
  });

  it('普通 Error → INTERNAL_ERROR；非 Error → INTERNAL_ERROR + String(error)', async () => {
    env.client.getTools.mockImplementationOnce(() => { throw new Error('tools down'); });
    expect(await call('listTools')).toEqual({ success: false, error: { code: 'INTERNAL_ERROR', message: 'tools down' } });
    env.refresh.mockImplementationOnce(async () => { throw 'raw refresh'; });
    expect(await call('refreshFromCloud')).toEqual({ success: false, error: { code: 'INTERNAL_ERROR', message: 'raw refresh' } });
  });

  it('带 code 字段的普通 Error 不透传（只认 McpInstallInProgressError）', async () => {
    env.client.getResources.mockImplementationOnce(() => { throw Object.assign(new Error('coded'), { code: 'EACCES' }); });
    expect(await call('listResources')).toEqual({ success: false, error: { code: 'INTERNAL_ERROR', message: 'coded' } });
  });
});
