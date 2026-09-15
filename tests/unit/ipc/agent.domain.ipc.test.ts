import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_DOMAINS, type IPCRequest, type IPCResponse } from '../../../src/shared/ipc';

// agent.ipc.ts 派发特征测试（RQ-183 续作·AGENT 刀迁表前钉住 switch 形态）：派发层 13 个 action。
// 既有覆盖：ipc-handlers.test.ts（send / cancel / 未知 action code / interrupt / getTree / getWorktreeReview / closeAgent）、
// sessionDefaultMode.test.ts（get/setSessionPermissionMode + 两处 admin 门）。这里补：permissionResponse 三分支、
// setPermissionMode 非法档与普通档返回形状、pause / resume 服务缺席与委派、sendMemberInput 入参校验、
// 未知 action 完整文案、非 Error 抛出 → String(error)。迁表后本文件零改动全绿即行为不变证明。

const env = vi.hoisted(() => ({
  pairingResolve: vi.fn((_id: string, _r: unknown) => false),
  setPermissionMode: vi.fn((_mode: string, _approved: boolean) => true),
  adminIpcError: null as null | { success: false; error: { code: string; message: string } },
}));

vi.mock('../../../src/host/channels/inboundPairingService', () => ({
  getInboundPairingService: () => ({ resolve: (id: string, r: unknown) => env.pairingResolve(id, r) }),
}));
vi.mock('../../../src/host/permissions/modes', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/host/permissions/modes')>()),
  setPermissionMode: (mode: string, approved: boolean) => env.setPermissionMode(mode, approved),
}));
vi.mock('../../../src/host/ipc/adminGuard', () => ({
  getAdminAccessIpcError: () => env.adminIpcError,
}));
// platform 按 sessionDefaultMode.test.ts 同款最小桩：agent.ipc 的 import 图里有模块在加载期读 app（09-15 草稿首跑实付）
vi.mock('../../../src/host/platform', () => ({
  app: { getVersion: () => '0.0.0-test' },
  AppWindow: { getFocusedWindow: () => null },
  broadcastToRenderer: vi.fn(),
}));

import { registerAgentHandlers } from '../../../src/host/ipc/agent.ipc';

type HandlerFn = (event: unknown, request: IPCRequest) => Promise<IPCResponse>;

const app = {
  handlePermissionResponse: vi.fn((..._a: unknown[]) => 'delivered'),
  pause: vi.fn(),
  resume: vi.fn(),
};
let appAvailable = true;
let call: (action: string, payload?: unknown) => Promise<IPCResponse>;

beforeEach(() => {
  vi.clearAllMocks();
  env.pairingResolve.mockReturnValue(false);
  env.setPermissionMode.mockReturnValue(true);
  env.adminIpcError = null;
  appAvailable = true;
  const handlers = new Map<string, HandlerFn>();
  registerAgentHandlers(
    { handle: (ch: string, fn: HandlerFn) => handlers.set(ch, fn) } as never,
    () => (appAvailable ? (app as never) : null),
  );
  const handler = handlers.get(IPC_DOMAINS.AGENT)!;
  call = (action, payload) => handler(null, { action, payload } as IPCRequest);
});

const notInitialized = { success: false, error: { code: 'INTERNAL_ERROR', message: 'Agent not initialized' } };

describe('agent.ipc dispatch 特征：permissionResponse', () => {
  it('入站配对先认领 → delivered，不碰应用服务', async () => {
    env.pairingResolve.mockReturnValueOnce(true);
    appAvailable = false;
    expect(await call('permissionResponse', { requestId: 'r1', response: 'allow' }))
      .toEqual({ success: true, data: { outcome: 'delivered' } });
    expect(env.pairingResolve).toHaveBeenCalledWith('r1', 'allow');
    expect(app.handlePermissionResponse).not.toHaveBeenCalled();
  });

  it('配对未认领且服务缺席 → INTERNAL_ERROR Agent not initialized', async () => {
    appAvailable = false;
    expect(await call('permissionResponse', { requestId: 'r1', response: 'deny' })).toEqual(notInitialized);
  });

  it('交给应用服务：四个参数透传，outcome 原样回传', async () => {
    app.handlePermissionResponse.mockReturnValueOnce('unknown_request');
    expect(await call('permissionResponse', { requestId: 'r2', response: 'allow', sessionId: 's1', updatedArgs: { a: 1 } }))
      .toEqual({ success: true, data: { outcome: 'unknown_request' } });
    expect(app.handlePermissionResponse).toHaveBeenCalledWith('r2', 'allow', 's1', { a: 1 });
  });
});

describe('agent.ipc dispatch 特征：setPermissionMode', () => {
  it('非法档 / 缺 mode → INVALID_PERMISSION_MODE Unknown permission mode，不写', async () => {
    const invalid = { success: false, error: { code: 'INVALID_PERMISSION_MODE', message: 'Unknown permission mode' } };
    expect(await call('setPermissionMode', { mode: 'full_access' })).toEqual(invalid);
    expect(await call('setPermissionMode')).toEqual(invalid);
    expect(env.setPermissionMode).not.toHaveBeenCalled();
  });

  it('普通档：approved 转布尔透传，返回 { changed, mode }；非 admin 不拦', async () => {
    env.adminIpcError = { success: false, error: { code: 'FORBIDDEN', message: 'nope' } };
    env.setPermissionMode.mockReturnValueOnce(false);
    expect(await call('setPermissionMode', { mode: 'acceptEdits' }))
      .toEqual({ success: true, data: { changed: false, mode: 'acceptEdits' } });
    expect(env.setPermissionMode).toHaveBeenCalledWith('acceptEdits', false);
  });
});

describe('agent.ipc dispatch 特征：pause / resume', () => {
  it('服务缺席 → INTERNAL_ERROR Agent not initialized', async () => {
    appAvailable = false;
    expect(await call('pause', { sessionId: 's1' })).toEqual(notInitialized);
    expect(await call('resume', { sessionId: 's1' })).toEqual(notInitialized);
  });

  it('委派 sessionId，返回 data null', async () => {
    expect(await call('pause', { sessionId: 's1' })).toEqual({ success: true, data: null });
    expect(app.pause).toHaveBeenCalledWith('s1');
    expect(await call('resume', { sessionId: 's2' })).toEqual({ success: true, data: null });
    expect(app.resume).toHaveBeenCalledWith('s2');
  });
});

describe('agent.ipc dispatch 特征：sendMemberInput 入参校验', () => {
  it('缺 sessionId / memberId / kind / message（含全空白）→ INVALID_MEMBER_INPUT', async () => {
    const invalid = { success: false, error: { code: 'INVALID_MEMBER_INPUT', message: 'sessionId, memberId, kind and message are required' } };
    const full = { sessionId: 's1', memberId: 'm1', kind: 'subagent', message: 'hi' };
    expect(await call('sendMemberInput', { ...full, sessionId: '' })).toEqual(invalid);
    expect(await call('sendMemberInput', { ...full, memberId: '  ' })).toEqual(invalid);
    expect(await call('sendMemberInput', { ...full, kind: undefined })).toEqual(invalid);
    expect(await call('sendMemberInput', { ...full, message: '   ' })).toEqual(invalid);
    expect(await call('sendMemberInput')).toEqual(invalid);
  });
});

describe('agent.ipc dispatch 特征：兜底', () => {
  it('未知 action → INVALID_ACTION + Unknown action 完整文案', async () => {
    expect(await call('bogus')).toEqual({ success: false, error: { code: 'INVALID_ACTION', message: 'Unknown action: bogus' } });
  });

  it('非 Error 抛出 → INTERNAL_ERROR + String(error)', async () => {
    app.pause.mockImplementationOnce(() => { throw 'raw pause'; });
    expect(await call('pause', { sessionId: 's1' })).toEqual({ success: false, error: { code: 'INTERNAL_ERROR', message: 'raw pause' } });
  });
});
