import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_DOMAINS, type IPCRequest, type IPCResponse } from '../../../src/shared/ipc';

// capture.ipc.ts 派发特征测试（RQ-183 续作·CAPTURE 刀迁表前钉住 switch 形态；派发层原本零测试）：派发层 9 个 action（计数以切块断言为准）。
// - capture / list / search / get / delete / stats：委派 captureService（注册期取一次）并原样回传，payload 解构透传
// - selectFiles：动态 import platform.dialog，取消 → []，否则回 filePaths；对话框标题与多选属性透传
// - importFiles：不支持的扩展名逐条记失败不中断；支持的文本文件走 captureService.capture（source local_file、metadata 带 size / ext）；单条抛错记失败并记日志
// - wechatStatus：watcher 正常回 status；取 watcher 抛错 → 内层兜底回 { watching: false, processedCount: 0 }
// - 未知 action → UNKNOWN_ACTION + `Unknown action: <action>`
// - 抛错 → 记 ('Capture IPC error', { action, error: message }) + CAPTURE_ERROR；Error 取 message、非 Error 为 'Unknown error'
// 迁表后本文件零改动全绿即行为不变证明。

const h = vi.hoisted(() => ({
  svc: {
    capture: vi.fn(async (req: unknown): Promise<unknown> => ({ id: 'c1', req })),
    list: vi.fn((_o: unknown): unknown => [{ id: 'c1' }]),
    search: vi.fn(async (_q: string, _k?: number): Promise<unknown> => [{ id: 'c1', score: 0.9 }]),
    get: vi.fn((_id: string): unknown => ({ id: 'c1' })),
    delete: vi.fn((_id: string): unknown => true),
    getStats: vi.fn((): unknown => ({ total: 1 })),
  },
  getServiceCalls: 0,
  dialog: { showOpenDialog: vi.fn(async (_o: unknown): Promise<{ canceled: boolean; filePaths: string[] }> => ({ canceled: false, filePaths: ['/a.md'] })) },
  watcher: { getStatus: vi.fn((): unknown => ({ watching: true, processedCount: 5 })) },
  watcherThrows: false,
  fs: {
    stat: vi.fn(async (_p: string): Promise<{ size: number }> => ({ size: 12 })),
    readFile: vi.fn(async (_p: string): Promise<Buffer> => Buffer.from('hello text')),
  },
  logError: vi.fn(),
}));

vi.mock('../../../src/host/services/knowledge/captureService', () => ({
  getCaptureService: () => { h.getServiceCalls += 1; return h.svc; },
}));
vi.mock('../../../src/host/context/documentContext/documentContextService', () => ({
  getDocumentContextService: () => ({ canParse: () => false, parse: vi.fn() }),
}));
vi.mock('../../../src/host/platform', () => ({ dialog: h.dialog }));
vi.mock('../../../src/host/services/connectors/wechatWatcher', () => ({
  getWeChatWatcher: () => { if (h.watcherThrows) throw new Error('no watcher'); return h.watcher; },
}));
vi.mock('fs', () => ({ default: { promises: h.fs }, promises: h.fs }));
vi.mock('child_process', () => ({ execFile: vi.fn() }));
vi.mock('../../../src/host/services/infra/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: h.logError, debug: vi.fn() }),
}));

import { registerCaptureHandlers } from '../../../src/host/ipc/capture.ipc';

type HandlerFn = (event: unknown, request: IPCRequest) => Promise<IPCResponse>;
let call: (action: string, payload?: unknown) => Promise<IPCResponse>;

beforeEach(() => {
  vi.clearAllMocks();
  h.getServiceCalls = 0;
  h.watcherThrows = false;
  const handlers = new Map<string, HandlerFn>();
  registerCaptureHandlers({ handle: (ch: string, fn: HandlerFn) => handlers.set(ch, fn) } as never);
  const handler = handlers.get(IPC_DOMAINS.CAPTURE)!;
  call = (action, payload) => handler(null, { action, payload } as IPCRequest);
});

describe('capture.ipc dispatch 特征：知识库委派', () => {
  it('capture / list / search / get / delete / stats 委派并原样回传', async () => {
    expect(await call('capture', { title: 't' })).toEqual({ success: true, data: { id: 'c1', req: { title: 't' } } });
    expect(await call('list', { limit: 5 })).toEqual({ success: true, data: [{ id: 'c1' }] });
    expect(h.svc.list).toHaveBeenCalledWith({ limit: 5 });
    expect(await call('search', { query: 'q', topK: 3 })).toEqual({ success: true, data: [{ id: 'c1', score: 0.9 }] });
    expect(h.svc.search).toHaveBeenCalledWith('q', 3);
    expect(await call('get', { id: 'c1' })).toEqual({ success: true, data: { id: 'c1' } });
    expect(await call('delete', { id: 'c1' })).toEqual({ success: true, data: true });
    expect(h.svc.delete).toHaveBeenCalledWith('c1');
    expect(await call('stats')).toEqual({ success: true, data: { total: 1 } });
  });
});

describe('capture.ipc dispatch 特征：文件导入与微信状态', () => {
  it('selectFiles：取消回 []，否则回 filePaths，多选属性透传', async () => {
    expect(await call('selectFiles')).toEqual({ success: true, data: ['/a.md'] });
    expect(h.dialog.showOpenDialog).toHaveBeenCalledWith(expect.objectContaining({ title: '选择文件导入到知识库', properties: ['openFile', 'multiSelections'] }));
    h.dialog.showOpenDialog.mockResolvedValueOnce({ canceled: true, filePaths: ['/b.md'] });
    expect(await call('selectFiles')).toEqual({ success: true, data: [] });
  });

  it('importFiles：不支持扩展名记失败不中断；文本文件入库；单条抛错记失败并记日志', async () => {
    h.svc.capture.mockRejectedValueOnce(new Error('embed down')).mockResolvedValueOnce({ id: 'ok' });
    const res = await call('importFiles', { filePaths: ['/x.exe', '/bad.md', '/good.txt'] });
    expect(res).toEqual({
      success: true,
      data: [
        { path: '/x.exe', success: false, error: '不支持的文件格式: .exe' },
        { path: '/bad.md', success: false, error: 'embed down' },
        { path: '/good.txt', success: true },
      ],
    });
    expect(h.svc.capture).toHaveBeenLastCalledWith({
      title: 'good.txt', content: 'hello text', source: 'local_file',
      metadata: { filePath: '/good.txt', fileSize: 12, fileExt: '.txt' },
    });
    expect(h.logError).toHaveBeenCalledWith('Failed to import file', { path: '/bad.md', error: 'embed down' });
  });

  it('wechatStatus：正常回 status；取 watcher 抛错走内层兜底', async () => {
    expect(await call('wechatStatus')).toEqual({ success: true, data: { watching: true, processedCount: 5 } });
    h.watcherThrows = true;
    expect(await call('wechatStatus')).toEqual({ success: true, data: { watching: false, processedCount: 0 } });
  });
});

describe('capture.ipc dispatch 特征：兜底', () => {
  it('captureService 注册期只取一次', async () => {
    await call('stats'); await call('list');
    expect(h.getServiceCalls).toBe(1);
  });

  it('未知 action → UNKNOWN_ACTION + 完整文案', async () => {
    expect(await call('bogus')).toEqual({ success: false, error: { code: 'UNKNOWN_ACTION', message: 'Unknown action: bogus' } });
  });

  it('抛 Error → CAPTURE_ERROR + message 并记带 action 的日志；抛非 Error → Unknown error', async () => {
    h.svc.getStats.mockImplementationOnce(() => { throw new Error('db gone'); });
    expect(await call('stats')).toEqual({ success: false, error: { code: 'CAPTURE_ERROR', message: 'db gone' } });
    expect(h.logError).toHaveBeenCalledWith('Capture IPC error', { action: 'stats', error: 'db gone' });
    h.svc.search.mockRejectedValueOnce('raw');
    expect(await call('search', { query: 'q' })).toEqual({ success: false, error: { code: 'CAPTURE_ERROR', message: 'Unknown error' } });
  });
});
