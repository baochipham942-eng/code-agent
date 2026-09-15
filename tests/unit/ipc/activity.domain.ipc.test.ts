import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_DOMAINS, type IPCRequest, type IPCResponse } from '../../../src/shared/ipc';

// activity.ipc.ts 派发特征测试（RQ-183 续作·ACTIVITY 刀迁表前钉住 switch 形态）：派发层 2 个 action（计数以切块断言为准）。
// 既有 activity.ipc.test.ts 覆盖 listProviders 聚合业务与未知 action 的 code。这里补派发层契约：
// - listProviders / getCurrentContext 委派与原样回传
// - 未知 action → INVALID_ACTION + `Unknown action: <action>` 完整文案
// - 抛错 → INTERNAL_ERROR：Error 取 message、非 Error 取 String(error)
// 迁表后本文件零改动全绿即行为不变证明。

const env = vi.hoisted(() => ({
  listProviders: vi.fn(async (): Promise<unknown> => ({ providers: [{ id: 'p1' }] })),
  getCurrentContext: vi.fn(async (): Promise<unknown> => ({ app: 'Code', window: 'x' })),
}));

vi.mock('../../../src/host/services/activity/activityProviderRegistry', () => ({
  listActivityProviders: () => env.listProviders(),
}));
vi.mock('../../../src/host/services/activity/activityContextProvider', () => ({
  getCurrentActivityContext: () => env.getCurrentContext(),
}));

import { registerActivityHandlers } from '../../../src/host/ipc/activity.ipc';

type HandlerFn = (event: unknown, request: IPCRequest) => Promise<IPCResponse>;
let call: (action: string, payload?: unknown) => Promise<IPCResponse>;

beforeEach(() => {
  vi.clearAllMocks();
  const handlers = new Map<string, HandlerFn>();
  registerActivityHandlers({ handle: (ch: string, fn: HandlerFn) => handlers.set(ch, fn) } as never);
  const handler = handlers.get(IPC_DOMAINS.ACTIVITY)!;
  call = (action, payload) => handler(null, { action, payload } as IPCRequest);
});

describe('activity.ipc dispatch 特征', () => {
  it('listProviders / getCurrentContext 委派并原样回传', async () => {
    expect(await call('listProviders')).toEqual({ success: true, data: { providers: [{ id: 'p1' }] } });
    expect(await call('getCurrentContext')).toEqual({ success: true, data: { app: 'Code', window: 'x' } });
    expect(env.listProviders).toHaveBeenCalledTimes(1);
    expect(env.getCurrentContext).toHaveBeenCalledTimes(1);
  });

  it('未知 action → INVALID_ACTION + 完整文案', async () => {
    expect(await call('bogus')).toEqual({ success: false, error: { code: 'INVALID_ACTION', message: 'Unknown action: bogus' } });
  });

  it('抛 Error → INTERNAL_ERROR + message；抛非 Error → String(error)', async () => {
    env.getCurrentContext.mockRejectedValueOnce(new Error('ctx down'));
    expect(await call('getCurrentContext')).toEqual({ success: false, error: { code: 'INTERNAL_ERROR', message: 'ctx down' } });
    env.listProviders.mockRejectedValueOnce('raw providers');
    expect(await call('listProviders')).toEqual({ success: false, error: { code: 'INTERNAL_ERROR', message: 'raw providers' } });
  });
});
