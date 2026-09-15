import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { IPC_DOMAINS, type IPCRequest, type IPCResponse } from '../../../src/shared/ipc';

// livePreview.ipc.ts 派发特征测试（RQ-183 续作·LIVE_PREVIEW 刀迁表前钉住 switch 形态）：派发层 11 个 action（计数以切块断言为准）。
// 既有 livePreview.ipc.test.ts 只测导出的两个纯函数（URL 校验、源码路径解析），派发层零覆盖。这里补：
// - ping 回 { pong, version }；validateDevServerUrl 缺 url → INVALID_ARGS、非法 → INVALID_URL（带 reason）、合法回规范化 url
// - resolveSourceLocation 缺 file → INVALID_ARGS；有 file 回 { absolute, relative, exists }；路径逃逸抛错 → LIVE_PREVIEW_ERROR
// - detectFramework / startDevServer：path 缺失或空白抛错 → LIVE_PREVIEW_ERROR 'path is required'；有值 trim 后委派
// - waitDevServerReady / stopDevServer / getDevServerSession / getDevServerLogs：sessionId 缺失抛错；有值委派（stop 回 { sessionId }）
// - listDevServers 原样回传；applyTweak 缺 location/mutation 或 file 非绝对 → INVALID_ARGS 完整文案，否则委派
// - 未知 action → UNKNOWN_ACTION + `未知 action: <action>`；非 Error 抛出 → String(err)
// 迁表后本文件零改动全绿即行为不变证明。

const h = vi.hoisted(() => ({
  mgr: {
    detect: vi.fn((_p: string): unknown => ({ framework: 'vite' })),
    start: vi.fn((_p: string): unknown => ({ id: 'ds1', status: 'starting', projectPath: '/proj' })),
    waitForReady: vi.fn(async (_id: string): Promise<string> => 'http://localhost:5173/'),
    stop: vi.fn(async (_id: string): Promise<void> => {}),
    get: vi.fn((_id: string): unknown => ({ id: 'ds1', projectPath: '/proj' })),
    getLogs: vi.fn((_id: string): unknown => ['ready']),
    list: vi.fn((): unknown => [{ id: 'ds1' }]),
  },
  applyTweak: vi.fn((_l: unknown, _m: unknown): unknown => ({ changed: true })),
}));

vi.mock('../../../src/host/services/infra/devServerManager', () => ({ getDevServerManager: () => h.mgr }));
vi.mock('../../../src/host/tools/livePreview/tweakWriter', () => ({ applyTweak: (l: unknown, m: unknown) => h.applyTweak(l, m) }));

import { registerLivePreviewHandlers } from '../../../src/host/ipc/livePreview.ipc';

type HandlerFn = (event: unknown, request: IPCRequest) => Promise<IPCResponse>;
let call: (action: string, payload?: unknown) => Promise<IPCResponse>;
const lpErr = (message: string) => ({ success: false, error: { code: 'LIVE_PREVIEW_ERROR', message } });
const invalid = (message: string) => ({ success: false, error: { code: 'INVALID_ARGS', message } });

beforeEach(() => {
  vi.clearAllMocks();
  const handlers = new Map<string, HandlerFn>();
  registerLivePreviewHandlers({ handle: (ch: string, fn: HandlerFn) => handlers.set(ch, fn) } as never);
  const handler = handlers.get(IPC_DOMAINS.LIVE_PREVIEW)!;
  call = (action, payload) => handler(null, { action, payload } as IPCRequest);
});

describe('livePreview.ipc dispatch 特征：校验与解析', () => {
  it('ping；validateDevServerUrl 缺参 / 非法 / 合法', async () => {
    expect(await call('ping')).toEqual({ success: true, data: { pong: true, version: '0.2.0' } });
    expect(await call('validateDevServerUrl', {})).toEqual(invalid('url is required'));
    expect(await call('validateDevServerUrl', { url: 'http://example.com' })).toEqual({ success: false, error: { code: 'INVALID_URL', message: 'Live Preview 仅支持 localhost / 127.0.0.1 dev server' } });
    expect(await call('validateDevServerUrl', { url: 'http://localhost:5173' })).toEqual({ success: true, data: { url: 'http://localhost:5173/' } });
  });

  it('resolveSourceLocation 缺 file / 正常解析 / 逃逸抛错落 LIVE_PREVIEW_ERROR', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'lp-'));
    writeFileSync(path.join(root, 'App.tsx'), 'x');
    expect(await call('resolveSourceLocation', {})).toEqual(invalid('file is required'));
    expect(await call('resolveSourceLocation', { file: 'App.tsx', projectRoot: root })).toEqual({ success: true, data: { absolute: path.join(root, 'App.tsx'), relative: 'App.tsx', exists: true } });
    const escaped = await call('resolveSourceLocation', { file: '../x.ts', projectRoot: root });
    expect(escaped.success).toBe(false);
    expect(escaped.error?.code).toBe('LIVE_PREVIEW_ERROR');
    expect(escaped.error?.message).toContain('路径逃逸');
  });
});

describe('livePreview.ipc dispatch 特征：dev server', () => {
  it('detectFramework / startDevServer：path 缺失或空白抛错；有值 trim 后委派', async () => {
    expect(await call('detectFramework', { path: '   ' })).toEqual(lpErr('path is required'));
    expect(await call('startDevServer')).toEqual(lpErr('path is required'));
    expect(await call('detectFramework', { path: ' /proj ' })).toEqual({ success: true, data: { framework: 'vite' } });
    expect(h.mgr.detect).toHaveBeenCalledWith('/proj');
    expect(await call('startDevServer', { path: '/proj' })).toEqual({ success: true, data: { id: 'ds1', status: 'starting', projectPath: '/proj' } });
  });

  it('sessionId 类四件：缺参抛错；有值委派，stop 回 { sessionId }', async () => {
    for (const a of ['waitDevServerReady', 'stopDevServer', 'getDevServerSession', 'getDevServerLogs']) {
      expect(await call(a, {})).toEqual(lpErr('sessionId is required'));
    }
    expect(await call('waitDevServerReady', { sessionId: 'ds1' })).toEqual({ success: true, data: { url: 'http://localhost:5173/' } });
    expect(await call('stopDevServer', { sessionId: 'ds1' })).toEqual({ success: true, data: { sessionId: 'ds1' } });
    expect(h.mgr.stop).toHaveBeenCalledWith('ds1');
    expect(await call('getDevServerSession', { sessionId: 'ds1' })).toEqual({ success: true, data: { id: 'ds1', projectPath: '/proj' } });
    expect(await call('getDevServerLogs', { sessionId: 'ds1' })).toEqual({ success: true, data: ['ready'] });
    expect(await call('listDevServers')).toEqual({ success: true, data: [{ id: 'ds1' }] });
  });
});

describe('livePreview.ipc dispatch 特征：applyTweak 与兜底', () => {
  it('applyTweak 缺参 / 相对路径 → INVALID_ARGS；绝对路径委派', async () => {
    expect(await call('applyTweak', { location: { file: '/a.tsx' } })).toEqual(invalid('location + mutation required'));
    expect(await call('applyTweak', { location: { file: 'a.tsx' }, mutation: { add: ['p-2'] } })).toEqual(invalid('file must be absolute'));
    expect(await call('applyTweak', { location: { file: '/a.tsx', line: 3 }, mutation: { add: ['p-2'] } })).toEqual({ success: true, data: { changed: true } });
    expect(h.applyTweak).toHaveBeenCalledWith({ file: '/a.tsx', line: 3 }, { add: ['p-2'] });
  });

  it('未知 action → UNKNOWN_ACTION + 中文文案；非 Error 抛出 → String(err)', async () => {
    expect(await call('bogus')).toEqual({ success: false, error: { code: 'UNKNOWN_ACTION', message: '未知 action: bogus' } });
    h.mgr.list.mockImplementationOnce(() => { throw 'raw list'; });
    expect(await call('listDevServers')).toEqual(lpErr('raw list'));
  });
});
