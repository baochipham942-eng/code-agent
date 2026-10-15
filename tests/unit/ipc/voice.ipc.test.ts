import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_DOMAINS, type IPCRequest } from '../../../src/shared/ipc';
import type { Message } from '../../../src/shared/contract/message';

const addMessageToSession = vi.fn(async (_sessionId: string, _message: Message) => undefined);
const recordVoiceCallFailure = vi.fn();
const injectVoiceUserText = vi.fn();
const getVoiceUserProfile = vi.fn();
const setVoiceUserProfile = vi.fn();
vi.mock('../../../src/host/services/voice/voiceUserProfile', () => ({
  getVoiceUserProfile, setVoiceUserProfile,
}));

vi.mock('../../../src/host/services/infra/sessionManager', () => ({
  getSessionManager: () => ({ addMessageToSession }),
}));
vi.mock('../../../src/host/services/voice/voiceUsageLedger', () => ({
  recordVoiceCallFailure,
}));
vi.mock('../../../src/host/services/voice/voiceSessionService', () => ({
  injectVoiceUserText,
}));
vi.mock('../../../src/host/services/infra/logger', () => ({
  createLogger: () => ({ warn: vi.fn() }),
}));

const { registerVoiceHandlers } = await import('../../../src/host/services/voice/voiceIpcContribution');

type Handler = (_event: unknown, request: IPCRequest) => Promise<unknown>;

describe('voice IPC failure report', () => {
  let handler: Handler;

  beforeEach(() => {
    addMessageToSession.mockClear();
    recordVoiceCallFailure.mockClear();
    injectVoiceUserText.mockReset();
    getVoiceUserProfile.mockReset();
    setVoiceUserProfile.mockReset();
    registerVoiceHandlers({
      handle: (domain: string, registered: Handler) => {
        expect(domain).toBe(IPC_DOMAINS.VOICE);
        handler = registered;
      },
      removeHandler: vi.fn(),
    } as never);
  });

  it('HANDSHAKE_FAILED 走 host 统一失败出口', async () => {
    const payload = {
      neoSessionId: 'neo-session-1',
      code: 'HANDSHAKE_FAILED' as const,
      phase: 'handshake' as const,
    };
    await expect(handler({}, { action: 'reportFailure', payload })).resolves.toEqual({ success: true });
    expect(recordVoiceCallFailure).toHaveBeenCalledTimes(1);
    expect(addMessageToSession).toHaveBeenCalledWith('neo-session-1', expect.objectContaining({
      role: 'system',
      metadata: expect.objectContaining({
        voiceCallFailure: expect.objectContaining({
          ...payload,
          timestamp: expect.any(Number),
        }),
      }),
    }));
  });

  it('拒绝 renderer 借通路上报 host 错误码或错配阶段', async () => {
    const response = await handler({}, {
      action: 'reportFailure',
      payload: { neoSessionId: 'neo-session-1', code: 'UPSTREAM_ERROR', phase: 'upstream' },
    });
    expect(response).toMatchObject({ success: false, error: { code: 'INVALID_ARGS' } });
    expect(addMessageToSession).not.toHaveBeenCalled();
    expect(recordVoiceCallFailure).not.toHaveBeenCalled();
  });

  it('把忙态打字注入交给 voice session，并透传 fallback 决策', async () => {
    injectVoiceUserText.mockResolvedValueOnce({
      outcome: 'fallback',
      reason: 'injection_rejected',
    });

    await expect(handler({}, {
      action: 'injectUserText',
      payload: { neoSessionId: 'neo-session-1', text: '改做 Y' },
    })).resolves.toEqual({
      success: true,
      data: { outcome: 'fallback', reason: 'injection_rejected' },
    });
    expect(injectVoiceUserText).toHaveBeenCalledWith('neo-session-1', '改做 Y');
  });

  it('拒绝空的打字注入请求', async () => {
    const response = await handler({}, {
      action: 'injectUserText',
      payload: { neoSessionId: 'neo-session-1', text: '   ' },
    });

    expect(response).toMatchObject({ success: false, error: { code: 'INVALID_ARGS' } });
    expect(injectVoiceUserText).not.toHaveBeenCalled();
  });

  it('returns the exact profile preview and forwards validated settings', async () => {
    const view = { enabled: true, override: null, text: '用户负责策展。' };
    getVoiceUserProfile.mockResolvedValue(view);
    setVoiceUserProfile.mockResolvedValue(view);
    await expect(handler({}, { action: 'getUserProfile' })).resolves.toEqual({ success: true, data: view });
    await expect(handler({}, { action: 'setUserProfile', payload: { enabled: true, override: null } }))
      .resolves.toEqual({ success: true, data: view });
    expect(setVoiceUserProfile).toHaveBeenCalledWith({ enabled: true, override: null });
  });

  it('rejects malformed and oversized profile writes before persistence', async () => {
    for (const payload of [undefined, { enabled: 'false', override: null }, { enabled: true }, { enabled: true, override: 'x'.repeat(601) }]) {
      await expect(handler({}, { action: 'setUserProfile', payload }))
        .resolves.toMatchObject({ success: false, error: { code: 'INVALID_ARGS' } });
    }
    expect(setVoiceUserProfile).not.toHaveBeenCalled();
  });

  it('reports unsafe edits and storage failures as stable codes without leaking profile text', async () => {
    setVoiceUserProfile.mockRejectedValueOnce(new Error('VOICE_USER_PROFILE_INVALID'));
    await expect(handler({}, { action: 'setUserProfile', payload: { enabled: true, override: '你是我的儿子' } }))
      .resolves.toMatchObject({ success: false, error: { code: 'VOICE_USER_PROFILE_INVALID' } });
    getVoiceUserProfile.mockRejectedValueOnce(new Error('private storage details'));
    await expect(handler({}, { action: 'getUserProfile' })).resolves.toEqual({
      success: false, error: { code: 'VOICE_USER_PROFILE_UNAVAILABLE', message: 'VOICE_USER_PROFILE_UNAVAILABLE' },
    });
  });

});
