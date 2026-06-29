// @vitest-environment jsdom
// 意图驱动自动认领（自主信封侧）：agent 在没手动点画布的会话里发 RequestDesignAutonomy
// （ownerSessionId===null）时，若请求来自当前会话 → 自动认领画布、不 decline、正常设 pendingRequest；
// 来自非当前会话 → decline 解阻（不抢当前画布）。owned-by-other → 仍 decline（H2-R2 保持）。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';

const { handlers, invokeMock } = vi.hoisted(() => ({
  handlers: new Map<string, (payload: unknown) => void>(),
  invokeMock: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../../../src/renderer/services/ipcService', () => {
  const on = vi.fn((channel: string, cb: (payload: unknown) => void) => {
    handlers.set(channel, cb);
    return () => handlers.delete(channel);
  });
  return { default: { on, invoke: invokeMock }, ipcService: { on, invoke: invokeMock } };
});

import { useAutonomyEnvelopeReview } from '../../../../src/renderer/components/design/useAutonomyEnvelopeReview';
import { useDesignAutonomyStore } from '../../../../src/renderer/components/design/designAutonomyStore';
import { useDesignCanvasStore } from '../../../../src/renderer/components/design/designCanvasStore';
import { useSessionStore } from '../../../../src/renderer/stores/sessionStore';
import { IPC_CHANNELS } from '../../../../src/shared/ipc';
import type { AutonomyEnvelopeRequest } from '../../../../src/shared/contract';

function fireAsk(request: AutonomyEnvelopeRequest): void {
  const cb = handlers.get(IPC_CHANNELS.CANVAS_AUTONOMY_ASK);
  if (!cb) throw new Error('CANVAS_AUTONOMY_ASK listener not registered');
  cb(request);
}

function makeReq(over: Partial<AutonomyEnvelopeRequest> = {}): AutonomyEnvelopeRequest {
  return { requestId: 'ae-1', goal: '探索 3 个方向', proposed: {}, ...over };
}

let markSpy: ReturnType<typeof vi.spyOn>;
let claimSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  handlers.clear();
  invokeMock.mockClear();
  useDesignAutonomyStore.setState({ pendingRequest: null, envelope: null });
  useDesignCanvasStore.setState({ ownerSessionId: null });
  useSessionStore.setState({ currentSessionId: null });
  // store action 引用稳定，spy 必须每个用例显式建立+还原，否则跨用例残留调用历史。
  markSpy = vi.spyOn(useDesignCanvasStore.getState(), 'markSessionDesignActive');
  claimSpy = vi.spyOn(useDesignCanvasStore.getState(), 'claimCanvasForSession');
});

afterEach(() => {
  markSpy.mockRestore();
  claimSpy.mockRestore();
  useDesignAutonomyStore.setState({ pendingRequest: null, envelope: null });
  useDesignCanvasStore.setState({ ownerSessionId: null });
  useSessionStore.setState({ currentSessionId: null });
});

describe('useAutonomyEnvelopeReview 意图驱动自动认领', () => {
  it('无主画布 + 请求来自当前会话 → 自动认领、不 decline、设 pendingRequest', () => {
    useDesignCanvasStore.setState({ ownerSessionId: null });
    useSessionStore.setState({ currentSessionId: 'S1' });
    renderHook(() => useAutonomyEnvelopeReview());

    fireAsk(makeReq({ requestId: 'ae-auto-1', sessionId: 'S1' }));

    expect(markSpy).toHaveBeenCalledWith('S1');
    expect(claimSpy).toHaveBeenCalledWith('S1');
    expect(useDesignCanvasStore.getState().ownerSessionId).toBe('S1');
    expect(invokeMock).not.toHaveBeenCalled();
    expect(useDesignAutonomyStore.getState().pendingRequest?.requestId).toBe('ae-auto-1');
  });

  it('无主画布 + 请求来自非当前会话 → decline 解阻、不认领、不设 pendingRequest', () => {
    useDesignCanvasStore.setState({ ownerSessionId: null });
    useSessionStore.setState({ currentSessionId: 'S1' });
    renderHook(() => useAutonomyEnvelopeReview());

    fireAsk(makeReq({ requestId: 'ae-auto-2', sessionId: 'S2' }));

    expect(claimSpy).not.toHaveBeenCalled();
    expect(invokeMock).toHaveBeenCalledTimes(1);
    const [channel, decision] = invokeMock.mock.calls[0];
    expect(channel).toBe(IPC_CHANNELS.CANVAS_AUTONOMY_RESPONSE);
    expect(decision).toMatchObject({ requestId: 'ae-auto-2', verdict: 'decline' });
    expect(useDesignAutonomyStore.getState().pendingRequest).toBeNull();
    expect(useDesignCanvasStore.getState().ownerSessionId).toBeNull();
  });

  it('画布属另一会话（owner=A）+ 请求来自当前会话 → 仍 decline（H2-R2 不破）', () => {
    useDesignCanvasStore.setState({ ownerSessionId: 'A' });
    useSessionStore.setState({ currentSessionId: 'B' });
    renderHook(() => useAutonomyEnvelopeReview());

    fireAsk(makeReq({ requestId: 'ae-auto-3', sessionId: 'B' }));

    expect(claimSpy).not.toHaveBeenCalled();
    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock.mock.calls[0][1]).toMatchObject({ requestId: 'ae-auto-3', verdict: 'decline' });
    expect(useDesignAutonomyStore.getState().pendingRequest).toBeNull();
    expect(useDesignCanvasStore.getState().ownerSessionId).toBe('A');
  });
});
