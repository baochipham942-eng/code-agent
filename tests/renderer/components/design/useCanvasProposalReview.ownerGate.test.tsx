// @vitest-environment jsdom
// H2-R2.c：写路径属主闸——renderer CANVAS_PROPOSAL_ASK 监听器在设 pending 前校验
// 画布属主==request.sessionId；跨会话 → respond verdict='reject' 解阻 agent、不设 pending、不弹审批条。
// request.sessionId 缺省 → 不拦（向后兼容）。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';

// 捕获注册到 ipcService.on 的各通道回调，供测试手动触发（vi.hoisted 提升到 mock 工厂之上）。
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

import { useCanvasProposalReview } from '../../../../src/renderer/components/design/useCanvasProposalReview';
import { useCanvasProposalStore } from '../../../../src/renderer/components/design/canvasProposalStore';
import { useDesignCanvasStore } from '../../../../src/renderer/components/design/designCanvasStore';
import { useDesignAutonomyStore } from '../../../../src/renderer/components/design/designAutonomyStore';
import { IPC_CHANNELS } from '../../../../src/shared/ipc';
import type { CanvasOpProposal } from '../../../../src/shared/contract';

function fireAsk(request: CanvasOpProposal): void {
  const cb = handlers.get(IPC_CHANNELS.CANVAS_PROPOSAL_ASK);
  if (!cb) throw new Error('CANVAS_PROPOSAL_ASK listener not registered');
  cb(request);
}

const validOps: CanvasOpProposal['ops'] = [{ kind: 'moveNode', nodeId: 'n1', x: 1, y: 2 }];

beforeEach(() => {
  handlers.clear();
  invokeMock.mockClear();
  useCanvasProposalStore.setState({ pending: null, applyingRequestId: null });
  useDesignCanvasStore.setState({ ownerSessionId: null });
  useDesignAutonomyStore.setState({ envelope: null });
});

afterEach(() => {
  useCanvasProposalStore.setState({ pending: null, applyingRequestId: null });
  useDesignCanvasStore.setState({ ownerSessionId: null });
});

describe('useCanvasProposalReview 写路径属主闸（H2-R2.c）', () => {
  it('跨会话提议（owner=A, request.sessionId=B）→ respond verdict=reject、不设 pending', () => {
    useDesignCanvasStore.setState({ ownerSessionId: 'A' });
    renderHook(() => useCanvasProposalReview());

    fireAsk({ requestId: 'cp-1', ops: validOps, sessionId: 'B' });

    expect(invokeMock).toHaveBeenCalledTimes(1);
    const [channel, decision] = invokeMock.mock.calls[0];
    expect(channel).toBe(IPC_CHANNELS.CANVAS_PROPOSAL_RESPONSE);
    expect(decision).toMatchObject({ requestId: 'cp-1', verdict: 'reject' });
    expect(useCanvasProposalStore.getState().pending).toBeNull();
  });

  it('同会话提议（owner=A, request.sessionId=A）→ 正常设 pending、不 reject', () => {
    useDesignCanvasStore.setState({ ownerSessionId: 'A' });
    renderHook(() => useCanvasProposalReview());

    fireAsk({ requestId: 'cp-2', ops: validOps, sessionId: 'A' });

    expect(invokeMock).not.toHaveBeenCalled();
    expect(useCanvasProposalStore.getState().pending?.requestId).toBe('cp-2');
  });

  it('request.sessionId 缺省 → 不拦（向后兼容），正常设 pending', () => {
    useDesignCanvasStore.setState({ ownerSessionId: 'A' });
    renderHook(() => useCanvasProposalReview());

    fireAsk({ requestId: 'cp-3', ops: validOps });

    expect(invokeMock).not.toHaveBeenCalled();
    expect(useCanvasProposalStore.getState().pending?.requestId).toBe('cp-3');
  });
});
