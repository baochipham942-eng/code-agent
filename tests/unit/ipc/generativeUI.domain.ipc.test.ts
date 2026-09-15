import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_DOMAINS, type IPCRequest, type IPCResponse } from '../../../src/shared/ipc';

// generativeUI.ipc.ts 派发特征测试（RQ-183 续作·GENERATIVE_UI 刀迁表前钉住现状）：既有 generativeUI.ipc.test.ts
// 只覆盖 resolveInstance / resolveManifest 各一条；这里补齐 capabilities、applyEvent、persistHtmlEdit 的参数校验与
// 委派，resolveInstance / resolveManifest 的 INVALID_ARGS 分支，未知 action 的 UNKNOWN_ACTION 'Unknown action:'，
// 以及抛错兜底（GENERATIVE_UI_ERROR，Error 取 message、非 Error 取 String，warn 日志带 action）。
// 迁表后本文件零改动全绿即行为不变证明。

const h = vi.hoisted(() => ({
  logWarn: vi.fn(),
  persist: vi.fn(),
  service: {
    isEnabled: vi.fn(() => true),
    isManifestEnabled: vi.fn(() => false),
    resolveInstance: vi.fn(),
    applyEvent: vi.fn(),
    resolveManifest: vi.fn(),
  },
}));

vi.mock('../../../src/host/services/generativeUI/generativeUIService', () => ({ getGenerativeUIService: () => h.service }));
vi.mock('../../../src/host/services/generativeUI/generativeUIEditPersistence', () => ({
  persistGenerativeUiEdit: (...a: unknown[]) => h.persist(...a),
}));
vi.mock('../../../src/host/services/infra/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: h.logWarn, error: vi.fn(), debug: vi.fn() }),
}));

import { registerGenerativeUIHandlers } from '../../../src/host/ipc/generativeUI.ipc';

type Handler = (event: unknown, request: IPCRequest) => Promise<IPCResponse>;
let handler: Handler;
const call = (action: string, payload?: unknown) => handler(null, { action, payload } as IPCRequest);
const invalid = (message: string) => ({ success: false, error: { code: 'INVALID_ARGS', message } });

beforeEach(() => {
  vi.clearAllMocks();
  const handlers = new Map<string, Handler>();
  registerGenerativeUIHandlers({ handle: (ch: string, fn: Handler) => handlers.set(ch, fn) } as never);
  handler = handlers.get(IPC_DOMAINS.GENERATIVE_UI)!;
});

describe('generativeUI.ipc dispatch 特征', () => {
  it('capabilities：两个开关原样映射', async () => {
    expect(await call('capabilities')).toEqual({ success: true, data: { nativeGenerativeUI: true, executionManifestV1: false } });
  });

  it('resolveInstance：四字段缺一 / sourceOrdinal 非整数 / rawSpec 非字符串 → INVALID_ARGS', async () => {
    const msg = 'sessionId, sourceMessageId, sourceOrdinal and rawSpec are required';
    expect(await call('resolveInstance')).toEqual(invalid(msg));
    expect(await call('resolveInstance', { sessionId: 's', sourceMessageId: 'm', sourceOrdinal: 1.5, rawSpec: '{}' })).toEqual(invalid(msg));
    expect(await call('resolveInstance', { sessionId: 's', sourceMessageId: 'm', sourceOrdinal: 0, rawSpec: 1 })).toEqual(invalid(msg));
    expect(h.service.resolveInstance).not.toHaveBeenCalled();
  });

  it('applyEvent：event 身份三字段缺一 → INVALID_ARGS；齐全则只传 event', async () => {
    expect(await call('applyEvent', { event: { eventId: 'e', sessionId: 's' } })).toEqual(invalid('event identity is required'));
    h.service.applyEvent.mockReturnValueOnce({ applied: true });
    const event = { eventId: 'e', sessionId: 's', instanceId: 'i', extra: 1 };
    expect(await call('applyEvent', { event, other: 2 })).toEqual({ success: true, data: { applied: true } });
    expect(h.service.applyEvent).toHaveBeenCalledWith(event);
  });

  it('persistHtmlEdit：六字段校验；齐全则 await 持久化结果', async () => {
    const msg = 'sessionId, messageId, sourceOrdinal, baseHash, newCode and fields are required';
    const ok = { sessionId: 's', messageId: 'm', sourceOrdinal: 2, baseHash: 'h', newCode: '<p/>', fields: [] };
    expect(await call('persistHtmlEdit', { ...ok, fields: 'x' })).toEqual(invalid(msg));
    expect(await call('persistHtmlEdit', { ...ok, baseHash: 3 })).toEqual(invalid(msg));
    h.persist.mockResolvedValueOnce({ newHash: 'h2' });
    expect(await call('persistHtmlEdit', ok)).toEqual({ success: true, data: { newHash: 'h2' } });
    expect(h.persist).toHaveBeenCalledWith(ok);
  });

  it('resolveManifest：身份三字段缺一 → INVALID_ARGS；decision 只认 approve / reject', async () => {
    expect(await call('resolveManifest', { sessionId: 's', manifestId: 'm' })).toEqual(invalid('sessionId, manifestId and nonce are required'));
    expect(await call('resolveManifest', { sessionId: 's', manifestId: 'm', nonce: 'n', decision: 'maybe' }))
      .toEqual(invalid('decision must be approve or reject'));
    expect(h.service.resolveManifest).not.toHaveBeenCalled();
  });

  it('未知 action → UNKNOWN_ACTION + Unknown action 文案', async () => {
    expect(await call('bogus')).toEqual({ success: false, error: { code: 'UNKNOWN_ACTION', message: 'Unknown action: bogus' } });
  });

  it('抛错 → GENERATIVE_UI_ERROR（Error 取 message、非 Error 取 String）并 warn 带 action', async () => {
    h.service.applyEvent.mockImplementationOnce(() => {
      throw new Error('instance gone');
    });
    expect(await call('applyEvent', { event: { eventId: 'e', sessionId: 's', instanceId: 'i' } }))
      .toEqual({ success: false, error: { code: 'GENERATIVE_UI_ERROR', message: 'instance gone' } });
    expect(h.logWarn).toHaveBeenLastCalledWith('Generative UI domain action failed', { action: 'applyEvent', message: 'instance gone' });
    h.persist.mockRejectedValueOnce('disk full');
    expect(await call('persistHtmlEdit', { sessionId: 's', messageId: 'm', sourceOrdinal: 0, baseHash: 'h', newCode: '', fields: [] }))
      .toEqual({ success: false, error: { code: 'GENERATIVE_UI_ERROR', message: 'disk full' } });
  });
});
