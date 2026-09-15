import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_DOMAINS, type IPCRequest, type IPCResponse } from '../../../src/shared/ipc';

// status.ipc.ts STATUS 域派发特征测试（RQ-183 续作·STATUS 刀迁表前钉住 switch 形态）：domain:status 派发层 2 个 action（计数以切块断言为准）。
// 同文件的 status:git-info / status:network 是独立通道，不在本域表化范围。
// 既有 statusCost.ipc.test.ts 覆盖 getTodayCost 双传输、getCostStats 合法 days 与 days=0 的 code。这里补派发层契约：
// - getCostStats 非法 days（0 / 1.5 / 字符串 / 缺 payload）→ INVALID_ARGS 完整文案，且不查库
// - 未知 action → INVALID_ACTION + `Unknown status action: <action>` 完整文案（带 status 前缀，非装配器缺省）
// - 抛错（取库在 try 内）→ INTERNAL_ERROR：Error 取 message、非 Error 取 String(error)
// 迁表后本文件零改动全绿即行为不变证明。

const env = vi.hoisted(() => ({
  dbThrows: null as null | unknown,
  repo: {
    getTodayCost: vi.fn((): unknown => ({ usd: 2, unknownTurns: 0 })),
    getCostStats: vi.fn((_days: number): unknown => [{ modelId: 'm', turns: 1, usd: 0.1, unknownTurns: 0 }]),
  },
}));

vi.mock('../../../src/host/services/core/databaseService', () => ({
  getDatabase: () => {
    if (env.dbThrows !== null) throw env.dbThrows;
    return { getTurnCostRepo: () => env.repo };
  },
}));
vi.mock('../../../src/host/services/infra/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { registerStatusHandlers } from '../../../src/host/ipc/status.ipc';

type HandlerFn = (event: unknown, request: IPCRequest) => Promise<IPCResponse>;
let call: (action: string, payload?: unknown) => Promise<IPCResponse>;

const BAD_DAYS = { success: false, error: { code: 'INVALID_ARGS', message: 'getCostStats requires a positive integer payload.days' } };

beforeEach(() => {
  vi.clearAllMocks();
  env.dbThrows = null;
  const handlers = new Map<string, HandlerFn>();
  registerStatusHandlers({ handle: (ch: string, fn: HandlerFn) => handlers.set(ch, fn) } as never);
  const handler = handlers.get(IPC_DOMAINS.STATUS)!;
  call = (action, payload) => handler(null, { action, payload } as IPCRequest);
});

describe('status.ipc STATUS dispatch 特征', () => {
  it('getTodayCost 原样回传', async () => {
    expect(await call('getTodayCost')).toEqual({ success: true, data: { usd: 2, unknownTurns: 0 } });
  });

  it('getCostStats 非法 days → INVALID_ARGS 完整文案且不查库', async () => {
    for (const payload of [{ days: 0 }, { days: 1.5 }, { days: '7' }, undefined]) {
      expect(await call('getCostStats', payload)).toEqual(BAD_DAYS);
    }
    expect(env.repo.getCostStats).not.toHaveBeenCalled();
    expect(await call('getCostStats', { days: 3 })).toEqual({ success: true, data: [{ modelId: 'm', turns: 1, usd: 0.1, unknownTurns: 0 }] });
    expect(env.repo.getCostStats).toHaveBeenCalledWith(3);
  });

  it('未知 action → INVALID_ACTION + 带 status 前缀的完整文案', async () => {
    expect(await call('bogus')).toEqual({ success: false, error: { code: 'INVALID_ACTION', message: 'Unknown status action: bogus' } });
  });

  it('取库抛 Error → INTERNAL_ERROR + message；抛非 Error → String(error)', async () => {
    env.dbThrows = new Error('db closed');
    expect(await call('getTodayCost')).toEqual({ success: false, error: { code: 'INTERNAL_ERROR', message: 'db closed' } });
    env.dbThrows = 'raw db';
    expect(await call('getCostStats', { days: 1 })).toEqual({ success: false, error: { code: 'INTERNAL_ERROR', message: 'raw db' } });
  });
});
