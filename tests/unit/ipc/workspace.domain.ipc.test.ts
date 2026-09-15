import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_DOMAINS, type IPCRequest, type IPCResponse } from '../../../src/shared/ipc';

// workspace.ipc.ts 派发特征测试（RQ-183 续作·WORKSPACE 刀迁表前钉住现状）：既有 workspace.openLinkInRail.ipc.test.ts
// 覆盖 openLinkInRail / closeLinkInRail / dispatchUserBrowserInput / controlUserBrowserHistory 的委派与空 workspace 兜底，
// 其余 13 份 workspace* 测试直测内部 helper、不经派发。这里补派发层：缺报的 openExternal（只认 http(s)）与
// setUserBrowserViewport（显式 workspace 与宽高透传）、closeLinkInRail 缺省 reason、shareLink 五件套 fallthrough 按 action
// 路由、未知 action 的 INVALID_ACTION 'Unknown action:'、抛错兜底 INTERNAL_ERROR（Error → message、非 Error → String）。
// 迁表后本文件零改动全绿即行为不变证明。

const h = vi.hoisted(() => ({
  openExternal: vi.fn(async (..._a: unknown[]) => undefined),
  share: vi.fn(async (..._a: unknown[]) => ({ ok: true })),
}));

vi.mock('../../../src/host/platform', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/host/platform')>()),
  shell: { openExternal: (...a: unknown[]) => h.openExternal(...a) },
}));
vi.mock('../../../src/host/ipc/workspaceShareLink.ipc', () => ({
  handleWorkspaceShareLinkAction: (...a: unknown[]) => h.share(...a),
}));

import { registerWorkspaceHandlers } from '../../../src/host/ipc/workspace.ipc';

type Handler = (event: unknown, request: IPCRequest) => Promise<IPCResponse>;
let handler: Handler;
const links = {
  open: vi.fn(async (..._a: unknown[]) => ({ opened: true })),
  end: vi.fn(async (..._a: unknown[]) => null),
  history: vi.fn(async (..._a: unknown[]) => ({ moved: true })),
  dispatchUserInput: vi.fn(async (..._a: unknown[]) => ({ dispatched: true })),
  setViewport: vi.fn(async (..._a: unknown[]) => ({ resized: true })),
};
const call = (action: string, payload?: unknown) => handler(null, { action, payload } as IPCRequest);

beforeEach(() => {
  vi.clearAllMocks();
  const handlers = new Map<string, Handler>();
  registerWorkspaceHandlers(
    { handle: (ch: string, fn: Handler) => handlers.set(ch, fn) } as never,
    () => null,
    () => null,
    () => null,
    () => links as never,
  );
  handler = handlers.get(IPC_DOMAINS.WORKSPACE)!;
});

describe('workspace.ipc dispatch 特征：缺报 action', () => {
  it('openExternal：非 http(s) → INTERNAL_ERROR 且不调 shell；http(s) 委派 shell.openExternal 并返回空串', async () => {
    expect(await call('openExternal', { url: 'file:///etc/passwd' }))
      .toEqual({ success: false, error: { code: 'INTERNAL_ERROR', message: 'openExternal only accepts http(s) URLs' } });
    expect(h.openExternal).not.toHaveBeenCalled();
    expect(await call('openExternal', { url: 'HTTPS://example.test/a' })).toEqual({ success: true, data: '' });
    expect(h.openExternal).toHaveBeenCalledWith('HTTPS://example.test/a');
  });

  it('setUserBrowserViewport：显式 workspace（trim）与宽高透传给 setViewport', async () => {
    expect(await call('setUserBrowserViewport', { conversationId: 'c1', workspace: '  /ws  ', width: 1280, height: 720 }))
      .toEqual({ success: true, data: { resized: true } });
    expect(links.setViewport).toHaveBeenCalledWith({ conversationId: 'c1', workspace: '/ws', width: 1280, height: 720 });
  });

  it('closeLinkInRail：reason 缺省按 user；openLinkInRail / controlUserBrowserHistory 显式 workspace 原样透传', async () => {
    expect(await call('closeLinkInRail', { conversationId: 'c1' })).toEqual({ success: true, data: null });
    expect(links.end).toHaveBeenCalledWith('c1', 'user');
    await call('openLinkInRail', { conversationId: 'c1', url: 'https://a.test', workspace: '/ws' });
    expect(links.open).toHaveBeenCalledWith({ conversationId: 'c1', url: 'https://a.test', workspace: '/ws' });
    await call('controlUserBrowserHistory', { conversationId: 'c1', workspace: '/ws', action: 'forward' });
    expect(links.history).toHaveBeenCalledWith({ conversationId: 'c1', workspace: '/ws', action: 'forward' });
  });
});

describe('workspace.ipc dispatch 特征：路由与兜底', () => {
  it('shareLink 五件套：各自以 (action, payload) 路由到 handleWorkspaceShareLinkAction', async () => {
    for (const action of ['getShareLink', 'createShareLink', 'updateShareLinkTtl', 'pushShareLink', 'revokeShareLink']) {
      const payload = { filePath: `/ws/${action}.html` };
      expect(await call(action, payload)).toEqual({ success: true, data: { ok: true } });
      expect(h.share).toHaveBeenLastCalledWith(action, payload);
    }
    expect(h.share).toHaveBeenCalledTimes(5);
  });

  it('未知 action → INVALID_ACTION + Unknown action 文案', async () => {
    expect(await call('bogus')).toEqual({ success: false, error: { code: 'INVALID_ACTION', message: 'Unknown action: bogus' } });
  });

  it('抛错兜底：Error → message；非 Error → String(error)', async () => {
    h.share.mockRejectedValueOnce(new Error('link expired'));
    expect(await call('pushShareLink', {})).toEqual({ success: false, error: { code: 'INTERNAL_ERROR', message: 'link expired' } });
    links.setViewport.mockRejectedValueOnce('boom');
    expect(await call('setUserBrowserViewport', { conversationId: 'c1', workspace: '/ws', width: 1, height: 1 }))
      .toEqual({ success: false, error: { code: 'INTERNAL_ERROR', message: 'boom' } });
  });
});
