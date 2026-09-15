import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_DOMAINS, type IPCRequest, type IPCResponse } from '../../../src/shared/ipc';

// connector.ipc.ts 派发特征测试（RQ-183 续作·CONNECTOR 刀迁表前钉住 switch 形态）：派发层 14 个 action，
// connector.dispatch.ipc.test.ts 覆盖 9 个原生动作 + 未知 action，connector.oauth.ipc.test.ts 覆盖 oauthStatus /
// Connect / CancelConnect / Disconnect 与 ADMIN_REQUIRED。这里补：oauthSaveDescriptor 缺 payload 的抛错映射，
// 以及 catch 的 code 判定链——错误自带 string code 原样透传 → 非 string code 回落 → 管理员安装文案 → ADMIN_REQUIRED
// → 其余 INTERNAL_ERROR；非 Error 抛出取 String(error)。迁表后本文件零改动全绿即行为不变证明。

const env = vi.hoisted(() => ({
  list: vi.fn((): unknown[] => []),
}));

vi.mock('../../../src/host/connectors', () => ({
  getConnectorRegistry: () => ({
    list: () => env.list(),
    get: () => undefined,
    configure: vi.fn(),
    unregister: vi.fn(),
    listAvailableNativeIds: () => [],
  }),
}));
vi.mock('../../../src/host/platform', () => ({ broadcastToRenderer: vi.fn() }));

import { registerConnectorHandlers } from '../../../src/host/ipc/connector.ipc';

type HandlerFn = (event: unknown, request: IPCRequest) => Promise<IPCResponse>;
let call: (action: string, payload?: unknown) => Promise<IPCResponse>;

beforeEach(() => {
  vi.useFakeTimers(); // 拦截 ensureConnectorStatusWatcher 的 setInterval
  vi.clearAllMocks();
  env.list.mockReturnValue([]);
  const handlers = new Map<string, HandlerFn>();
  registerConnectorHandlers(
    { handle: (ch: string, fn: HandlerFn) => handlers.set(ch, fn) } as never,
    () => null,
    () => null,
  );
  const handler = handlers.get(IPC_DOMAINS.CONNECTOR)!;
  call = (action, payload) => handler(null, { action, payload } as IPCRequest);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('connector.ipc dispatch 特征：oauthSaveDescriptor', () => {
  it('缺 payload → INTERNAL_ERROR + Custom OAuth descriptor is required', async () => {
    expect(await call('oauthSaveDescriptor')).toEqual({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'Custom OAuth descriptor is required' },
    });
  });
});

describe('connector.ipc dispatch 特征：抛错 code 判定链', () => {
  it('错误自带 string code → 原样透传', async () => {
    env.list.mockImplementationOnce(() => { throw Object.assign(new Error('busy'), { code: 'CONNECTOR_BUSY' }); });
    expect(await call('listStatuses')).toEqual({ success: false, error: { code: 'CONNECTOR_BUSY', message: 'busy' } });
  });

  it('code 非 string → 不透传，回落 INTERNAL_ERROR', async () => {
    env.list.mockImplementationOnce(() => { throw Object.assign(new Error('numeric'), { code: 42 }); });
    expect(await call('listStatuses')).toEqual({ success: false, error: { code: 'INTERNAL_ERROR', message: 'numeric' } });
  });

  it('管理员安装文案 → ADMIN_REQUIRED（不限 oauth 动作）', async () => {
    env.list.mockImplementationOnce(() => { throw new Error('需联系企业应用管理员安装'); });
    expect(await call('listStatuses')).toEqual({ success: false, error: { code: 'ADMIN_REQUIRED', message: '需联系企业应用管理员安装' } });
  });

  it('非 Error 抛出 → INTERNAL_ERROR + String(error)', async () => {
    env.list.mockImplementationOnce(() => { throw 'raw boom'; });
    expect(await call('listStatuses')).toEqual({ success: false, error: { code: 'INTERNAL_ERROR', message: 'raw boom' } });
  });

  it('带 string code 的非 Error 对象 → 透传 code，message 取 String(error)', async () => {
    env.list.mockImplementationOnce(() => { throw { code: 'PLAIN_CODE' }; });
    expect(await call('listStatuses')).toEqual({ success: false, error: { code: 'PLAIN_CODE', message: '[object Object]' } });
  });
});
