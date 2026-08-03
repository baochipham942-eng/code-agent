// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DomainInvokeError, invokeDomain } from '../../../src/renderer/services/ipcService';

/**
 * 守的是「宿主给的 error.code 能穿过 IPC 这一跳」。
 * 上面那份横幅测试把 invokeDomain 整个 mock 掉了，跑不到这段生产代码——
 * 2026-08-02 变异验证实测：拿掉 code 传递，横幅测试仍全绿（假绿），故补这条。
 */
function stubDomainApi(response: unknown): void {
  (window as unknown as { domainAPI?: unknown }).domainAPI = {
    invoke: vi.fn().mockResolvedValue(response),
  };
}

afterEach(() => {
  delete (window as unknown as { domainAPI?: unknown }).domainAPI;
});

describe('invokeDomain 的错误信封', () => {
  it('把宿主的 error.code 原样带到抛出的错误上', async () => {
    stubDomainApi({ success: false, error: { code: 'BRANCH_NOT_FOUND', message: 'no immutable branch exists' } });

    await expect(invokeDomain('session', 'replayConversationBranch', { sessionId: 's1' }))
      .rejects.toMatchObject({ code: 'BRANCH_NOT_FOUND', message: 'no immutable branch exists' });
  });

  it('抛出的是 DomainInvokeError，调用方可用 instanceof 判定', async () => {
    stubDomainApi({ success: false, error: { code: 'BRANCH_QUARANTINED', message: 'quarantined' } });

    await expect(invokeDomain('session', 'replayConversationBranch', { sessionId: 's2' }))
      .rejects.toBeInstanceOf(DomainInvokeError);
  });

  it('宿主没给 code 时兜底成 INTERNAL_ERROR，不留 undefined', async () => {
    stubDomainApi({ success: false, error: { message: 'boom' } });

    await expect(invokeDomain('session', 'someAction', { sessionId: 's3' }))
      .rejects.toMatchObject({ code: 'INTERNAL_ERROR' });
  });

  it('成功时原样返回 data', async () => {
    stubDomainApi({ success: true, data: { ok: 1 } });

    await expect(invokeDomain('session', 'someAction', { sessionId: 's4' })).resolves.toEqual({ ok: 1 });
  });
});
