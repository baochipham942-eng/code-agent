import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_CHANNELS, IPC_DOMAINS, type IPCRequest, type IPCResponse } from '../../../src/shared/ipc';

// terminal.ipc.ts 派发特征测试（RQ-183 续作·TERMINAL 刀迁表前钉住 switch 形态；派发层原本零测试）：派发层 6 个 action（计数以切块断言为准）。
// - 注册期副作用只做一次：输出 / reveal 桥接 broadcastToRenderer、收割孤儿 PTY（模块级标记，重复注册不重复）
// - open：缺 sessionId → INVALID_ARGS '缺少 sessionId'；cwd 缺省取家目录；cols/rows 只认有限数
// - write：缺 sessionId / 缺 data → INVALID_ARGS；成功 { written: true }；失败 WRITE_FAILED（无 error 文案时 'write failed'）
// - resize：缺 cols/rows（含 0）→ INVALID_ARGS '缺少 cols/rows'；close 等待 dispose；snapshot / list 原样回传
// - 未知 action → UNKNOWN_ACTION + `未知 action: <action>`；抛错 → TERMINAL_ERROR：Error 取 message、非 Error 取 String(err)
// 迁表后本文件零改动全绿即行为不变证明。模块有进程级标记，每条用例 resetModules 重新加载。

const h = vi.hoisted(() => ({
  broadcast: vi.fn(),
  outputCb: null as null | ((sessionId: string, data: string) => void),
  revealCb: null as null | ((sessionId: string) => void),
  mgr: {
    dispose: vi.fn(async (_id: string): Promise<boolean> => true),
    snapshot: vi.fn((_id: string): unknown => ({ lines: ['$'] })),
    list: vi.fn((): unknown => [{ sessionId: 's1' }]),
    open: vi.fn((_o: unknown): unknown => ({ lines: [] })),
    reap: vi.fn(),
    resize: vi.fn((_id: string, _c: number, _r: number): boolean => true),
    write: vi.fn((_id: string, _d: string): { ok: boolean; error?: string } => ({ ok: true })),
  },
}));

vi.mock('../../../src/host/platform/windowBridge', () => ({ broadcastToRenderer: (...a: unknown[]) => h.broadcast(...a) }));
vi.mock('../../../src/host/config/configPaths', () => ({ getHomeDir: () => '/home/t' }));
vi.mock('../../../src/host/services/terminal/terminalSessionManager', () => ({
  disposeTerminalSession: (id: string) => h.mgr.dispose(id),
  getTerminalSnapshot: (id: string) => h.mgr.snapshot(id),
  listTerminalSessions: () => h.mgr.list(),
  onTerminalOutput: (cb: (s: string, d: string) => void) => { h.outputCb = cb; },
  onTerminalReveal: (cb: (s: string) => void) => { h.revealCb = cb; },
  openTerminalSession: (o: unknown) => h.mgr.open(o),
  reapOrphanTerminals: () => h.mgr.reap(),
  resizeTerminalSession: (id: string, c: number, r: number) => h.mgr.resize(id, c, r),
  writeToTerminalSession: (id: string, d: string) => h.mgr.write(id, d),
}));

type HandlerFn = (event: unknown, request: IPCRequest) => Promise<IPCResponse>;
let registerTwice: () => void;
let call: (action: string, payload?: unknown) => Promise<IPCResponse>;

const invalid = (message: string) => ({ success: false, error: { code: 'INVALID_ARGS', message } });

beforeEach(async () => {
  vi.clearAllMocks();
  vi.resetModules();
  h.outputCb = null; h.revealCb = null;
  const { registerTerminalHandlers } = await import('../../../src/host/ipc/terminal.ipc');
  const handlers = new Map<string, HandlerFn>();
  const ipc = { handle: (ch: string, fn: HandlerFn) => handlers.set(ch, fn) } as never;
  registerTerminalHandlers(ipc);
  registerTwice = () => registerTerminalHandlers(ipc);
  call = (action, payload) => handlers.get(IPC_DOMAINS.TERMINAL)!(null, { action, payload } as IPCRequest);
});

describe('terminal.ipc 注册期副作用', () => {
  it('桥接输出 / reveal 并收割孤儿，重复注册不重复', () => {
    registerTwice();
    expect(h.mgr.reap).toHaveBeenCalledTimes(1);
    h.outputCb!('s1', 'hi');
    h.revealCb!('s2');
    expect(h.broadcast).toHaveBeenCalledWith(IPC_CHANNELS.TERMINAL_OUTPUT, { sessionId: 's1', data: 'hi' });
    expect(h.broadcast).toHaveBeenCalledWith(IPC_CHANNELS.TERMINAL_REVEAL, { sessionId: 's2' });
  });
});

describe('terminal.ipc dispatch 特征', () => {
  it('open：缺 sessionId 报错；cwd 缺省家目录；cols/rows 只认有限数', async () => {
    expect(await call('open', {})).toEqual(invalid('缺少 sessionId'));
    expect(await call('open', { sessionId: 's1', cols: 80, rows: Infinity })).toEqual({ success: true, data: { lines: [] } });
    expect(h.mgr.open).toHaveBeenLastCalledWith({ sessionId: 's1', cwd: '/home/t', cols: 80, rows: undefined });
    await call('open', { sessionId: 's1', cwd: '/w', cols: '80' });
    expect(h.mgr.open).toHaveBeenLastCalledWith({ sessionId: 's1', cwd: '/w', cols: undefined, rows: undefined });
  });

  it('write：缺参 / 成功 / 失败 WRITE_FAILED 与缺省文案', async () => {
    expect(await call('write', { data: 'x' })).toEqual(invalid('缺少 sessionId'));
    expect(await call('write', { sessionId: 's1' })).toEqual(invalid('缺少 data'));
    expect(await call('write', { sessionId: 's1', data: '' })).toEqual({ success: true, data: { written: true } });
    expect(h.mgr.write).toHaveBeenLastCalledWith('s1', '');
    h.mgr.write.mockReturnValueOnce({ ok: false, error: 'pty gone' });
    expect(await call('write', { sessionId: 's1', data: 'x' })).toEqual({ success: false, error: { code: 'WRITE_FAILED', message: 'pty gone' } });
    h.mgr.write.mockReturnValueOnce({ ok: false });
    expect(await call('write', { sessionId: 's1', data: 'x' })).toEqual({ success: false, error: { code: 'WRITE_FAILED', message: 'write failed' } });
  });

  it('resize / close / snapshot / list', async () => {
    expect(await call('resize', { sessionId: 's1', cols: 0, rows: 24 })).toEqual(invalid('缺少 cols/rows'));
    expect(await call('resize', { sessionId: 's1', cols: 100, rows: 30 })).toEqual({ success: true, data: { resized: true } });
    expect(h.mgr.resize).toHaveBeenCalledWith('s1', 100, 30);
    expect(await call('close', {})).toEqual(invalid('缺少 sessionId'));
    expect(await call('close', { sessionId: 's1' })).toEqual({ success: true, data: { closed: true } });
    expect(await call('snapshot', { sessionId: 's1' })).toEqual({ success: true, data: { lines: ['$'] } });
    expect(await call('list')).toEqual({ success: true, data: [{ sessionId: 's1' }] });
  });

  it('未知 action → UNKNOWN_ACTION + 中文完整文案', async () => {
    expect(await call('bogus')).toEqual({ success: false, error: { code: 'UNKNOWN_ACTION', message: '未知 action: bogus' } });
  });

  it('抛 Error → TERMINAL_ERROR + message；抛非 Error → String(err)', async () => {
    h.mgr.dispose.mockRejectedValueOnce(new Error('kill failed'));
    expect(await call('close', { sessionId: 's1' })).toEqual({ success: false, error: { code: 'TERMINAL_ERROR', message: 'kill failed' } });
    h.mgr.list.mockImplementationOnce(() => { throw 'raw list'; });
    expect(await call('list')).toEqual({ success: false, error: { code: 'TERMINAL_ERROR', message: 'raw list' } });
  });
});
