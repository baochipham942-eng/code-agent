import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_DOMAINS, type IPCRequest, type IPCResponse } from '../../../src/shared/ipc';

// folderTrust.ipc.ts 派发特征测试（RQ-183 续作·FOLDER_TRUST 刀迁表前钉住现状；派发层原本零测试，
// folderTrustWorkingDirectory.test.ts 只测 resolveWorkingDirectory）：get / set / revoke 以解析出的
// workingDirectory 委派，set 的 state 只认 trusted / blocked（INVALID_PAYLOAD 逐字），未知 action 的
// INVALID_ACTION 'Unknown action:'，抛错 INTERNAL_ERROR（Error → message、非 Error → String）。
// 注意：原实现先解析 workingDirectory 再分发——未知 action 也会先解析。迁表后本文件零改动全绿即行为不变证明。

const h = vi.hoisted(() => ({
  evaluate: vi.fn(),
  set: vi.fn(),
  revoke: vi.fn(),
}));

vi.mock('../../../src/host/security/folderTrustService', () => ({
  evaluateFolderTrust: (...a: unknown[]) => h.evaluate(...a),
  setFolderTrust: (...a: unknown[]) => h.set(...a),
  revokeFolderTrust: (...a: unknown[]) => h.revoke(...a),
}));

import { registerFolderTrustHandlers } from '../../../src/host/ipc/folderTrust.ipc';

type Handler = (event: unknown, request: IPCRequest) => Promise<IPCResponse>;
let handler: Handler;
let appWorkingDirectory: string | null;
const call = (action: string, payload?: unknown) => handler(null, { action, payload } as IPCRequest);

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('CODE_AGENT_WEB_MODE', 'false');
  appWorkingDirectory = '/app/wd';
  const handlers = new Map<string, Handler>();
  registerFolderTrustHandlers(
    { handle: (ch: string, fn: Handler) => handlers.set(ch, fn) } as never,
    () => ({ getWorkingDirectory: () => appWorkingDirectory }) as never,
  );
  handler = handlers.get(IPC_DOMAINS.FOLDER_TRUST)!;
});

describe('folderTrust.ipc dispatch 特征', () => {
  it('get：显式 workingDirectory 优先；缺省走 app 级目录', async () => {
    h.evaluate.mockResolvedValue({ state: 'trusted' });
    expect(await call('get', { workingDirectory: '/explicit' })).toEqual({ success: true, data: { state: 'trusted' } });
    expect(h.evaluate).toHaveBeenLastCalledWith('/explicit');
    await call('get');
    expect(h.evaluate).toHaveBeenLastCalledWith('/app/wd');
  });

  it('set：state 只认 trusted / blocked（INVALID_PAYLOAD 逐字）；合法则透传 decidedBy', async () => {
    expect(await call('set', { state: 'maybe' }))
      .toEqual({ success: false, error: { code: 'INVALID_PAYLOAD', message: 'folderTrust:set requires state trusted or blocked.' } });
    expect(h.set).not.toHaveBeenCalled();
    h.set.mockResolvedValueOnce({ state: 'blocked' });
    expect(await call('set', { workingDirectory: '/w', state: 'blocked', decidedBy: 'user' })).toEqual({ success: true, data: { state: 'blocked' } });
    expect(h.set).toHaveBeenCalledWith('/w', 'blocked', 'user');
  });

  it('revoke：以解析出的目录委派', async () => {
    h.revoke.mockResolvedValueOnce({ revoked: true });
    expect(await call('revoke', { workingDirectory: '/w' })).toEqual({ success: true, data: { revoked: true } });
    expect(h.revoke).toHaveBeenCalledWith('/w');
  });

  it('未知 action → INVALID_ACTION + Unknown action 文案', async () => {
    expect(await call('bogus')).toEqual({ success: false, error: { code: 'INVALID_ACTION', message: 'Unknown action: bogus' } });
  });

  it('抛错 → INTERNAL_ERROR（Error 取 message、非 Error 取 String）', async () => {
    h.evaluate.mockRejectedValueOnce(new Error('db locked'));
    expect(await call('get')).toEqual({ success: false, error: { code: 'INTERNAL_ERROR', message: 'db locked' } });
    h.revoke.mockRejectedValueOnce('boom');
    expect(await call('revoke')).toEqual({ success: false, error: { code: 'INTERNAL_ERROR', message: 'boom' } });
  });
});
