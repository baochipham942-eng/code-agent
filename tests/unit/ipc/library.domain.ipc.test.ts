import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_DOMAINS, type IPCRequest, type IPCResponse } from '../../../src/shared/ipc';

// library.ipc.ts 派发特征测试（RQ-183 续作·LIBRARY 刀迁表前钉住 switch 形态）：派发层 9 个 action。
// 既有 library.ipc.test.ts 覆盖 list / get / addItem / importFiles / setPin 的校验与业务、LIBRARY_ERROR code、未知 action code。
// 这里补派发层契约：
// - update / delete / getPin / pinnedItems 的缺参 INVALID_ARGS 文案、NOT_FOUND 文案、成功回传形状（delete 成功无 data 键）
// - get 命中回传；addItem / setPin 缺参完整文案
// - 未知 action → UNKNOWN_ACTION + `Unknown library action: <action>` 完整文案
// - 抛错 → LIBRARY_ERROR：Error 取 message、非 Error 取 String(error)，并以 { action, error } 记 error 日志
// 迁表后本文件零改动全绿即行为不变证明。

const env = vi.hoisted(() => ({
  svc: {
    list: vi.fn(),
    get: vi.fn(),
    addItem: vi.fn(),
    importFile: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    getPin: vi.fn(),
    setPinnedItems: vi.fn(),
    getPinnedItems: vi.fn(),
  },
  logError: vi.fn(),
}));

vi.mock('../../../src/host/services/library/libraryService', () => ({
  getLibraryService: () => env.svc,
}));
vi.mock('../../../src/host/services/infra/logger', () => ({
  createLogger: () => ({ error: env.logError, warn: vi.fn(), info: vi.fn(), debug: vi.fn() }),
}));

import { registerLibraryHandlers } from '../../../src/host/ipc/library.ipc';

type HandlerFn = (event: unknown, request: IPCRequest) => Promise<IPCResponse>;
let call: (action: string, payload?: unknown) => Promise<IPCResponse>;

const invalid = (message: string) => ({ success: false, error: { code: 'INVALID_ARGS', message } });
const notFound = { success: false, error: { code: 'NOT_FOUND', message: 'library item not found' } };

beforeEach(() => {
  vi.clearAllMocks();
  const handlers = new Map<string, HandlerFn>();
  registerLibraryHandlers({ handle: (ch: string, fn: HandlerFn) => handlers.set(ch, fn) } as never);
  const handler = handlers.get(IPC_DOMAINS.LIBRARY)!;
  call = (action, payload) => handler(null, { action, payload } as IPCRequest);
});

describe('library.ipc dispatch 特征：条目', () => {
  it('get 命中原样回传', async () => {
    env.svc.get.mockReturnValue({ id: 'i1' });
    expect(await call('get', { itemId: 'i1' })).toEqual({ success: true, data: { id: 'i1' } });
    expect(env.svc.get).toHaveBeenCalledWith('i1');
  });

  it('addItem 缺必填完整文案', async () => {
    expect(await call('addItem')).toEqual(invalid('title, kind and pathOrUri are required'));
  });

  it('update 缺 itemId / 未命中 / 命中透传局部字段', async () => {
    expect(await call('update', {})).toEqual(invalid('itemId is required'));
    env.svc.update.mockReturnValueOnce(undefined);
    expect(await call('update', { itemId: 'x' })).toEqual(notFound);
    env.svc.update.mockReturnValueOnce({ id: 'x', title: 't' });
    expect(await call('update', { itemId: 'x', title: 't', tags: ['a'], summary: null, projectId: 'p', extra: 1 }))
      .toEqual({ success: true, data: { id: 'x', title: 't' } });
    expect(env.svc.update).toHaveBeenLastCalledWith('x', { title: 't', tags: ['a'], summary: null, projectId: 'p' });
  });

  it('delete 缺 itemId / 未命中 / 成功无 data 键', async () => {
    expect(await call('delete')).toEqual(invalid('itemId is required'));
    env.svc.delete.mockReturnValueOnce(false);
    expect(await call('delete', { itemId: 'x' })).toEqual(notFound);
    env.svc.delete.mockReturnValueOnce(true);
    const ok = await call('delete', { itemId: 'x' });
    expect(ok).toEqual({ success: true });
    expect(Object.keys(ok)).toEqual(['success']);
  });
});

describe('library.ipc dispatch 特征：pin', () => {
  it('getPin / pinnedItems 缺 sessionId 与成功回传', async () => {
    expect(await call('getPin', {})).toEqual(invalid('sessionId is required'));
    expect(await call('pinnedItems')).toEqual(invalid('sessionId is required'));
    env.svc.getPin.mockReturnValue({ sessionId: 's', itemIds: ['a'] });
    env.svc.getPinnedItems.mockReturnValue([{ id: 'a' }]);
    expect(await call('getPin', { sessionId: 's' })).toEqual({ success: true, data: { sessionId: 's', itemIds: ['a'] } });
    expect(await call('pinnedItems', { sessionId: 's' })).toEqual({ success: true, data: [{ id: 'a' }] });
    expect(env.svc.getPinnedItems).toHaveBeenCalledWith('s');
  });

  it('setPin 缺参完整文案与透传', async () => {
    expect(await call('setPin', {})).toEqual(invalid('sessionId is required'));
    expect(await call('setPin', { sessionId: 's' })).toEqual(invalid('itemIds must be an array'));
    env.svc.setPinnedItems.mockReturnValue({ sessionId: 's', itemIds: ['a'] });
    expect(await call('setPin', { sessionId: 's', itemIds: ['a'] })).toEqual({ success: true, data: { sessionId: 's', itemIds: ['a'] } });
    expect(env.svc.setPinnedItems).toHaveBeenCalledWith('s', ['a']);
  });
});

describe('library.ipc dispatch 特征：兜底', () => {
  it('未知 action → UNKNOWN_ACTION + 完整文案', async () => {
    expect(await call('bogus')).toEqual({ success: false, error: { code: 'UNKNOWN_ACTION', message: 'Unknown library action: bogus' } });
  });

  it('Error → LIBRARY_ERROR + message，并记带 action 的 error 日志', async () => {
    const err = new Error('pin db down');
    env.svc.getPin.mockImplementationOnce(() => { throw err; });
    expect(await call('getPin', { sessionId: 's' })).toEqual({ success: false, error: { code: 'LIBRARY_ERROR', message: 'pin db down' } });
    expect(env.logError).toHaveBeenCalledWith('Library IPC failed', { action: 'getPin', error: err });
  });

  it('非 Error → LIBRARY_ERROR + String(error)', async () => {
    env.svc.list.mockImplementationOnce(() => { throw 'raw list'; });
    expect(await call('list')).toEqual({ success: false, error: { code: 'LIBRARY_ERROR', message: 'raw list' } });
  });
});
