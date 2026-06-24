// @vitest-environment jsdom
// 意图驱动自动认领：agent 在没手动点画布的会话里调 proposeCanvasOps（ownerSessionId===null）时，
// 若提议来自当前会话 → 该会话自动认领画布（markSessionDesignActive + claimCanvasForSession），
// 不 reject、正常设 pending；若提议来自非当前会话 → 仍 reject 解阻（不抢当前画布，H2-R2 保持）。
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

import { useCanvasProposalReview } from '../../../../src/renderer/components/design/useCanvasProposalReview';
import { useCanvasProposalStore } from '../../../../src/renderer/components/design/canvasProposalStore';
import { useDesignCanvasStore } from '../../../../src/renderer/components/design/designCanvasStore';
import { useDesignAutonomyStore } from '../../../../src/renderer/components/design/designAutonomyStore';
import { useSessionStore } from '../../../../src/renderer/stores/sessionStore';
import { IPC_CHANNELS } from '../../../../src/shared/ipc';
import type { CanvasOpProposal } from '../../../../src/shared/contract';

function fireAsk(request: CanvasOpProposal): void {
  const cb = handlers.get(IPC_CHANNELS.CANVAS_PROPOSAL_ASK);
  if (!cb) throw new Error('CANVAS_PROPOSAL_ASK listener not registered');
  cb(request);
}

const validOps: CanvasOpProposal['ops'] = [{ kind: 'moveNode', nodeId: 'n1', x: 1, y: 2 }];

let markSpy: ReturnType<typeof vi.spyOn>;
let claimSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  handlers.clear();
  invokeMock.mockClear();
  useCanvasProposalStore.setState({ pending: null, applyingRequestId: null });
  useDesignCanvasStore.setState({ ownerSessionId: null });
  useDesignAutonomyStore.setState({ envelope: null });
  useSessionStore.setState({ currentSessionId: null });
  // store action 引用稳定，spy 必须每个用例显式建立+还原，否则跨用例残留调用历史。
  markSpy = vi.spyOn(useSessionStore.getState(), 'markSessionDesignActive');
  claimSpy = vi.spyOn(useDesignCanvasStore.getState(), 'claimCanvasForSession');
});

afterEach(() => {
  markSpy.mockRestore();
  claimSpy.mockRestore();
  useCanvasProposalStore.setState({ pending: null, applyingRequestId: null });
  useDesignCanvasStore.setState({ ownerSessionId: null });
  useSessionStore.setState({ currentSessionId: null });
});

describe('useCanvasProposalReview 意图驱动自动认领', () => {
  it('无主画布 + 提议来自当前会话 → 自动认领（markSessionDesignActive + claimCanvasForSession）、不 reject、设 pending', () => {
    useDesignCanvasStore.setState({ ownerSessionId: null });
    useSessionStore.setState({ currentSessionId: 'S1' });
    renderHook(() => useCanvasProposalReview());

    fireAsk({ requestId: 'cp-auto-1', ops: validOps, sessionId: 'S1' });

    expect(markSpy).toHaveBeenCalledWith('S1');
    expect(claimSpy).toHaveBeenCalledWith('S1');
    // 认领后属主即为该会话
    expect(useDesignCanvasStore.getState().ownerSessionId).toBe('S1');
    // 不拒绝、不解阻；正常进入待审批
    expect(invokeMock).not.toHaveBeenCalled();
    expect(useCanvasProposalStore.getState().pending?.requestId).toBe('cp-auto-1');
  });

  it('无主画布 + 提议来自非当前会话（背景会话）→ reject 解阻、不认领、不设 pending（不抢当前画布）', () => {
    useDesignCanvasStore.setState({ ownerSessionId: null });
    useSessionStore.setState({ currentSessionId: 'S1' });
    renderHook(() => useCanvasProposalReview());

    fireAsk({ requestId: 'cp-auto-2', ops: validOps, sessionId: 'S2' });

    expect(markSpy).not.toHaveBeenCalled();
    expect(claimSpy).not.toHaveBeenCalled();
    expect(invokeMock).toHaveBeenCalledTimes(1);
    const [channel, decision] = invokeMock.mock.calls[0];
    expect(channel).toBe(IPC_CHANNELS.CANVAS_PROPOSAL_RESPONSE);
    expect(decision).toMatchObject({ requestId: 'cp-auto-2', verdict: 'reject' });
    expect(useCanvasProposalStore.getState().pending).toBeNull();
    expect(useDesignCanvasStore.getState().ownerSessionId).toBeNull();
  });

  it('画布属另一会话（owner=A）+ 提议来自当前会话 → 仍 reject（H2-R2 不破，owned-by-other 不认领）', () => {
    useDesignCanvasStore.setState({ ownerSessionId: 'A' });
    useSessionStore.setState({ currentSessionId: 'B' });
    renderHook(() => useCanvasProposalReview());

    fireAsk({ requestId: 'cp-auto-3', ops: validOps, sessionId: 'B' });

    expect(claimSpy).not.toHaveBeenCalled();
    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock.mock.calls[0][1]).toMatchObject({ requestId: 'cp-auto-3', verdict: 'reject' });
    expect(useCanvasProposalStore.getState().pending).toBeNull();
    expect(useDesignCanvasStore.getState().ownerSessionId).toBe('A');
  });
});
