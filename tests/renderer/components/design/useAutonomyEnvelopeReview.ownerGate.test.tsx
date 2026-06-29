// @vitest-environment jsdom
// H2-R2.d：自主信封写路径属主闸——renderer CANVAS_AUTONOMY_ASK 监听器在设 pendingRequest 前
// 校验画布属主==request.sessionId；跨会话 → 回 decline 裁决解阻 agent、不设 pendingRequest（不弹面板）。
// request.sessionId 缺省 → 不拦（向后兼容）。
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

beforeEach(() => {
  handlers.clear();
  invokeMock.mockClear();
  useDesignAutonomyStore.setState({ pendingRequest: null, envelope: null });
  useDesignCanvasStore.setState({ ownerSessionId: null });
});

afterEach(() => {
  useDesignAutonomyStore.setState({ pendingRequest: null, envelope: null });
  useDesignCanvasStore.setState({ ownerSessionId: null });
});

describe('useAutonomyEnvelopeReview 写路径属主闸（H2-R2.d）', () => {
  it('跨会话信封请求（owner=A, request.sessionId=B）→ 回 decline 解阻、不设 pendingRequest', () => {
    useDesignCanvasStore.setState({ ownerSessionId: 'A' });
    renderHook(() => useAutonomyEnvelopeReview());

    fireAsk(makeReq({ requestId: 'ae-x', sessionId: 'B' }));

    expect(invokeMock).toHaveBeenCalledTimes(1);
    const [channel, decision] = invokeMock.mock.calls[0];
    expect(channel).toBe(IPC_CHANNELS.CANVAS_AUTONOMY_RESPONSE);
    expect(decision).toMatchObject({ requestId: 'ae-x', verdict: 'decline' });
    expect(useDesignAutonomyStore.getState().pendingRequest).toBeNull();
  });

  it('同会话信封请求（owner=A, request.sessionId=A）→ 正常设 pendingRequest、不 decline', () => {
    useDesignCanvasStore.setState({ ownerSessionId: 'A' });
    renderHook(() => useAutonomyEnvelopeReview());

    fireAsk(makeReq({ requestId: 'ae-2', sessionId: 'A' }));

    expect(invokeMock).not.toHaveBeenCalled();
    expect(useDesignAutonomyStore.getState().pendingRequest?.requestId).toBe('ae-2');
  });

  it('request.sessionId 缺省 → 不拦（向后兼容），正常设 pendingRequest', () => {
    useDesignCanvasStore.setState({ ownerSessionId: 'A' });
    renderHook(() => useAutonomyEnvelopeReview());

    fireAsk(makeReq({ requestId: 'ae-3' }));

    expect(invokeMock).not.toHaveBeenCalled();
    expect(useDesignAutonomyStore.getState().pendingRequest?.requestId).toBe('ae-3');
  });
});
