import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IPCResponse } from '../../../src/shared/ipc';
import { IPC_DOMAINS } from '../../../src/shared/ipc';

const mocks = vi.hoisted(() => ({
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
}));

vi.mock('../../../src/host/services/library/libraryService', () => ({
  getLibraryService: () => mocks.svc,
}));

import { registerLibraryHandlers } from '../../../src/host/ipc/library.ipc';

type HandlerFn = (event: unknown, request: unknown) => Promise<unknown>;

function createMockIpcMain() {
  const handlers = new Map<string, HandlerFn>();
  return {
    ipcHost: {
      handle: vi.fn((channel: string, handler: HandlerFn) => {
        handlers.set(channel, handler);
      }),
    },
    invoke<T>(channel: string, request: unknown): Promise<T> {
      const handler = handlers.get(channel);
      if (!handler) throw new Error(`No handler registered for ${channel}`);
      return handler({}, request) as Promise<T>;
    },
  };
}

describe('library IPC', () => {
  let ipc: ReturnType<typeof createMockIpcMain>;

  beforeEach(() => {
    vi.clearAllMocks();
    ipc = createMockIpcMain();
    registerLibraryHandlers(ipc.ipcHost as never);
  });

  function invoke(action: string, payload?: unknown): Promise<IPCResponse> {
    return ipc.invoke<IPCResponse>(IPC_DOMAINS.LIBRARY, { action, payload });
  }

  it('list 透传 options 并返回 data', async () => {
    mocks.svc.list.mockReturnValue([{ id: 'a' }]);
    const res = await invoke('list', { projectId: 'p1' });
    expect(res).toEqual({ success: true, data: [{ id: 'a' }] });
    expect(mocks.svc.list).toHaveBeenCalledWith({ projectId: 'p1' });
  });

  it('get 缺 itemId 报 INVALID_ARGS，未命中报 NOT_FOUND', async () => {
    expect((await invoke('get', {})).error?.code).toBe('INVALID_ARGS');
    mocks.svc.get.mockReturnValue(undefined);
    expect((await invoke('get', { itemId: 'x' })).error?.code).toBe('NOT_FOUND');
  });

  it('addItem 校验必填字段', async () => {
    expect((await invoke('addItem', { title: 'a' })).error?.code).toBe('INVALID_ARGS');
    mocks.svc.addItem.mockReturnValue({ id: 'a' });
    const res = await invoke('addItem', { title: 'a', kind: 'artifact', pathOrUri: '/x' });
    expect(res.success).toBe(true);
  });

  it('importFiles 空 paths 拒绝；单文件失败不拖死整批', async () => {
    expect((await invoke('importFiles', { paths: [] })).error?.code).toBe('INVALID_ARGS');

    mocks.svc.importFile
      .mockReturnValueOnce({ id: 'ok' })
      .mockImplementationOnce(() => { throw new Error('boom'); });
    const res = await invoke('importFiles', { paths: ['/a', '/b'] });
    expect(res.success).toBe(true);
    expect(res.data).toEqual({
      items: [{ id: 'ok' }],
      errors: [{ path: '/b', message: 'boom' }],
    });
  });

  it('setPin 校验 sessionId 与 itemIds 数组', async () => {
    expect((await invoke('setPin', { itemIds: [] })).error?.code).toBe('INVALID_ARGS');
    expect((await invoke('setPin', { sessionId: 's', itemIds: 'x' })).error?.code).toBe('INVALID_ARGS');
    mocks.svc.setPinnedItems.mockReturnValue({ sessionId: 's', itemIds: [], addedAt: 1 });
    expect((await invoke('setPin', { sessionId: 's', itemIds: [] })).success).toBe(true);
  });

  it('服务抛错映射为 LIBRARY_ERROR', async () => {
    mocks.svc.list.mockImplementation(() => { throw new Error('db down'); });
    const res = await invoke('list');
    expect(res.error?.code).toBe('LIBRARY_ERROR');
    expect(res.error?.message).toBe('db down');
  });

  it('未知 action 报 UNKNOWN_ACTION', async () => {
    expect((await invoke('nope')).error?.code).toBe('UNKNOWN_ACTION');
  });
});
