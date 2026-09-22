import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_DOMAINS, type IPCRequest, type IPCResponse } from '../../../src/shared/ipc';

// loop.ipc.ts 派发特征测试（RQ-183 续作·LOOP 刀迁表前钉住现状；派发层原本零测试）：
// start 的参数校验 / prompt trim / durable 仅显式传入才带 / 数字只认有限数，stop / get 缺 id 报错，
// list 透传 sessionId，未知 action 的 UNKNOWN_ACTION 'Unknown loop action:' 契约，抛错兜底：
// 错误自带 string code 透传、否则 LOOP_ERROR，非 Error → 'Unknown error'，并记日志。
// 迁表后本文件零改动全绿即行为不变证明。

const h = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, request: IPCRequest) => Promise<IPCResponse>>(),
  logError: vi.fn(),
  controller: {
    start: vi.fn(async (..._a: unknown[]) => ({ id: 'loop-1' })),
    stop: vi.fn((..._a: unknown[]) => true),
    list: vi.fn((..._a: unknown[]) => [{ id: 'loop-1' }]),
    get: vi.fn((..._a: unknown[]) => ({ id: 'loop-1', status: 'running' })),
  },
}));

vi.mock('../../../src/host/platform', () => ({
  ipcHost: { handle: (ch: string, fn: (event: unknown, request: IPCRequest) => Promise<IPCResponse>) => h.handlers.set(ch, fn) },
}));
vi.mock('../../../src/host/loop', () => ({ getLoopController: () => h.controller }));
vi.mock('../../../src/host/services/infra/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: h.logError, debug: vi.fn() }),
}));

import { registerLoopHandlers } from '../../../src/host/ipc/loop.ipc';

const call = (action: string, payload?: unknown) =>
  h.handlers.get(IPC_DOMAINS.LOOP)!(null, { action, payload } as IPCRequest);

beforeEach(() => {
  vi.clearAllMocks();
  h.handlers.clear();
  registerLoopHandlers();
});

describe('loop.ipc dispatch 特征', () => {
  it('start：prompt trim 后传入；数字只认有限数；durable 仅显式传入才带', async () => {
    expect(await call('start', { sessionId: 's1', prompt: '  看看 CI  ', intervalMs: 60000, maxTurns: Infinity, until: 'done' }))
      .toEqual({ success: true, data: { id: 'loop-1' } });
    expect(h.controller.start).toHaveBeenLastCalledWith({ sessionId: 's1', prompt: '看看 CI', intervalMs: 60000, maxTurns: undefined, until: 'done' });
    await call('start', { sessionId: 's1', prompt: 'x', durable: false, intervalMs: '60' });
    expect(h.controller.start).toHaveBeenLastCalledWith({ sessionId: 's1', prompt: 'x', intervalMs: undefined, maxTurns: undefined, until: undefined, durable: false });
  });

  it('start：缺 sessionId / 空白 prompt → LOOP_ERROR 中文文案并记日志', async () => {
    expect(await call('start', { prompt: 'x' })).toEqual({ success: false, error: { code: 'LOOP_ERROR', message: '缺少 sessionId' } });
    expect(await call('start', { sessionId: 's1', prompt: '   ' })).toEqual({ success: false, error: { code: 'LOOP_ERROR', message: '缺少 prompt' } });
    expect(h.logError).toHaveBeenCalledWith('Loop IPC error:', expect.any(Error));
    expect(h.controller.start).not.toHaveBeenCalled();
  });

  it('stop / get：缺 id → LOOP_ERROR；有 id 透传；list 透传 sessionId（缺省 undefined）', async () => {
    expect(await call('stop', {})).toEqual({ success: false, error: { code: 'LOOP_ERROR', message: '缺少 loop id' } });
    expect(await call('get')).toEqual({ success: false, error: { code: 'LOOP_ERROR', message: '缺少 loop id' } });
    expect(await call('stop', { id: 'loop-1' })).toEqual({ success: true, data: true });
    expect(await call('get', { id: 'loop-1' })).toEqual({ success: true, data: { id: 'loop-1', status: 'running' } });
    expect(await call('list', { sessionId: 's1' })).toEqual({ success: true, data: [{ id: 'loop-1' }] });
    expect(h.controller.list).toHaveBeenLastCalledWith('s1');
    await call('list');
    expect(h.controller.list).toHaveBeenLastCalledWith(undefined);
  });

  it('未知 action → UNKNOWN_ACTION + Unknown loop action 文案', async () => {
    expect(await call('bogus')).toEqual({ success: false, error: { code: 'UNKNOWN_ACTION', message: 'Unknown loop action: bogus' } });
  });

  it('错误自带 string code → 透传；非 Error 抛出 → LOOP_ERROR + Unknown error', async () => {
    h.controller.start.mockRejectedValueOnce(Object.assign(new Error('durable parent missing'), { code: 'LOOP_DURABLE_PARENT_MISSING' }));
    expect(await call('start', { sessionId: 's1', prompt: 'x' }))
      .toEqual({ success: false, error: { code: 'LOOP_DURABLE_PARENT_MISSING', message: 'durable parent missing' } });
    h.controller.get.mockImplementationOnce(() => {
      throw 'boom';
    });
    expect(await call('get', { id: 'loop-1' })).toEqual({ success: false, error: { code: 'LOOP_ERROR', message: 'Unknown error' } });
  });
});
