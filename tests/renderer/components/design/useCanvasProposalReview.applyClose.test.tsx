// @vitest-environment jsdom
// 秒关 UX：点「应用」立即关审批条（pending=null），出图在画布上以忙态指示进行——
// 不让弹窗在整个 ~15s 出图期间卡着。验证：
//  1) apply 调用后、出图 promise 尚未 resolve 时 pending 已为 null；
//  2) setApplying 在出图期间为 true、finally 后 null（单飞锁不破）；
//  3) 出图期间 setGenerating(true)、结束 false（画布忙态反馈）；
//  4) applyProposal reject → toast.error 被调；
//  5) reject 路径不受影响（仍正常 respond 并清条）。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';

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

// applyProposal / rejectProposal 注入：apply 用可控 deferred promise 模拟 ~15s 出图。
const { applyProposalMock, rejectProposalMock } = vi.hoisted(() => ({
  applyProposalMock: vi.fn(),
  rejectProposalMock: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../../../src/renderer/components/design/canvasProposalController', () => ({
  applyProposal: applyProposalMock,
  rejectProposal: rejectProposalMock,
}));

const { toastErrorMock } = vi.hoisted(() => ({ toastErrorMock: vi.fn() }));
vi.mock('../../../../src/renderer/hooks/useToast', () => ({
  toast: { error: toastErrorMock, success: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

import { useCanvasProposalReview } from '../../../../src/renderer/components/design/useCanvasProposalReview';
import { useCanvasProposalStore } from '../../../../src/renderer/components/design/canvasProposalStore';
import { useDesignCanvasStore } from '../../../../src/renderer/components/design/designCanvasStore';
import type { CanvasOpProposal } from '../../../../src/shared/contract';

function pendingProposal(requestId = 'cp-apply-1'): CanvasOpProposal {
  return { requestId, ops: [{ kind: 'moveNode', nodeId: 'n1', x: 1, y: 2 }] } as unknown as CanvasOpProposal;
}

let setGeneratingSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  handlers.clear();
  invokeMock.mockClear();
  applyProposalMock.mockReset();
  rejectProposalMock.mockReset().mockResolvedValue(undefined);
  toastErrorMock.mockReset();
  useCanvasProposalStore.setState({ pending: null, applyingRequestId: null });
  useDesignCanvasStore.setState({ ownerSessionId: null, generating: false });
  setGeneratingSpy = vi.spyOn(useDesignCanvasStore.getState(), 'setGenerating');
});

afterEach(() => {
  setGeneratingSpy.mockRestore();
  useCanvasProposalStore.setState({ pending: null, applyingRequestId: null });
});

describe('useCanvasProposalReview 点应用秒关 + 画布忙态', () => {
  it('点应用：pending 立即变 null（出图 promise 未 resolve）；applying=requestId；resolve 后 applying=null', async () => {
    let resolveGen: (v: unknown) => void = () => {};
    const genPromise = new Promise((r) => { resolveGen = r; });
    applyProposalMock.mockReturnValue(genPromise);

    const { result } = renderHook(() => useCanvasProposalReview());
    useCanvasProposalStore.setState({ pending: pendingProposal() });

    let applyDone: Promise<unknown> = Promise.resolve();
    act(() => { applyDone = result.current.apply(); });

    // 秒关：出图还没结束，审批条 pending 已清。
    expect(useCanvasProposalStore.getState().pending).toBeNull();
    // 单飞锁仍在（出图进行中）。
    expect(useCanvasProposalStore.getState().applyingRequestId).toBe('cp-apply-1');

    await act(async () => { resolveGen(undefined); await applyDone; });

    // 出图结束：锁释放。
    expect(useCanvasProposalStore.getState().applyingRequestId).toBeNull();
    expect(useCanvasProposalStore.getState().pending).toBeNull();
  });

  it('出图期间 setGenerating(true)，结束 setGenerating(false)', async () => {
    let resolveGen: (v: unknown) => void = () => {};
    const genPromise = new Promise((r) => { resolveGen = r; });
    applyProposalMock.mockReturnValue(genPromise);

    const { result } = renderHook(() => useCanvasProposalReview());
    useCanvasProposalStore.setState({ pending: pendingProposal() });

    let applyDone: Promise<unknown> = Promise.resolve();
    act(() => { applyDone = result.current.apply(); });

    expect(setGeneratingSpy).toHaveBeenCalledWith(true);
    expect(setGeneratingSpy).not.toHaveBeenCalledWith(false);

    await act(async () => { resolveGen(undefined); await applyDone; });

    expect(setGeneratingSpy).toHaveBeenCalledWith(false);
  });

  it('applyProposal reject → toast.error 被调（用户在弹窗关后仍知道失败）', async () => {
    applyProposalMock.mockRejectedValue(new Error('智谱余额不足'));

    const { result } = renderHook(() => useCanvasProposalReview());
    useCanvasProposalStore.setState({ pending: pendingProposal() });

    await act(async () => { await result.current.apply(); });

    expect(toastErrorMock).toHaveBeenCalledTimes(1);
    expect(String(toastErrorMock.mock.calls[0][0])).toContain('智谱余额不足');
    // 失败也要释放锁。
    expect(useCanvasProposalStore.getState().applyingRequestId).toBeNull();
  });

  it('reject 路径不受影响：respond + 清条，不调 applyProposal/setGenerating', async () => {
    const { result } = renderHook(() => useCanvasProposalReview());
    useCanvasProposalStore.setState({ pending: pendingProposal('cp-rej-1') });

    await act(async () => { await result.current.reject('换个配色'); });

    expect(rejectProposalMock).toHaveBeenCalledTimes(1);
    expect(applyProposalMock).not.toHaveBeenCalled();
    expect(setGeneratingSpy).not.toHaveBeenCalled();
    expect(useCanvasProposalStore.getState().pending).toBeNull();
    expect(useCanvasProposalStore.getState().applyingRequestId).toBeNull();
  });
});
