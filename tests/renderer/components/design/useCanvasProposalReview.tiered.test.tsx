// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';

const { handlers, invokeMock } = vi.hoisted(() => ({
  handlers: new Map<string, (payload: unknown) => void>(),
  invokeMock: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../../../src/renderer/services/ipcService', () => {
  const on = vi.fn((channel: string, callback: (payload: unknown) => void) => {
    handlers.set(channel, callback);
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
import type { CanvasImageNode, DesignCanvasDoc } from '../../../../src/renderer/components/design/designCanvasTypes';
import type { CanvasOpProposal } from '../../../../src/shared/contract';

const node = (id: string, over: Partial<CanvasImageNode> = {}): CanvasImageNode => ({
  id,
  src: `assets/${id}.png`,
  x: 0,
  y: 0,
  width: 100,
  height: 100,
  createdAt: 1,
  createdBy: 'agent',
  ...over,
});

function load(nodes: CanvasImageNode[]): void {
  const doc: DesignCanvasDoc = { version: 1, nodes, camera: { x: 0, y: 0, scale: 1 } };
  useDesignCanvasStore.getState().loadDoc(null, doc);
  useDesignCanvasStore.setState({ ownerSessionId: 'S1' });
}

function fireAsk(proposal: CanvasOpProposal): void {
  const callback = handlers.get(IPC_CHANNELS.CANVAS_PROPOSAL_ASK);
  if (!callback) throw new Error('CANVAS_PROPOSAL_ASK listener missing');
  callback(proposal);
}

beforeEach(() => {
  handlers.clear();
  invokeMock.mockClear();
  useCanvasProposalStore.setState({
    pending: null,
    preApplied: null,
    approvalReason: 'standard',
    applyingRequestId: null,
  });
  useDesignAutonomyStore.setState({ envelope: null });
  useSessionStore.setState({ currentSessionId: 'S1', messages: [] });
  load([node('A'), node('B')]);
});

afterEach(() => {
  useCanvasProposalStore.getState().clear();
  useCanvasProposalStore.setState({ applyingRequestId: null });
  useSessionStore.setState({ currentSessionId: null, messages: [] });
});

describe('useCanvasProposalReview 分级落地', () => {
  it('新增实体免批落地、回执可见，且一次 undo 撤掉整批', async () => {
    renderHook(() => useCanvasProposalReview());
    fireAsk({
      requestId: 'direct-add',
      sessionId: 'S1',
      ops: [
        { kind: 'addShape', shape: { kind: 'text', x: 1, y: 2, text: '标题' } },
        { kind: 'addConnector', fromNodeId: 'A', toNodeId: 'B' },
      ],
    });

    await waitFor(() => expect(useDesignCanvasStore.getState().shapes).toHaveLength(1));
    expect(useDesignCanvasStore.getState().connectors).toHaveLength(1);
    expect(useCanvasProposalStore.getState().pending).toBeNull();
    expect(useSessionStore.getState().messages.at(-1)?.content).toContain('已在画布落地 2 项，可撤销');
    expect(invokeMock).toHaveBeenCalledWith(IPC_CHANNELS.CANVAS_PROPOSAL_RESPONSE, expect.objectContaining({
      requestId: 'direct-add', verdict: 'apply', appliedCount: 2,
    }));

    useDesignCanvasStore.getState().undoEdit();
    expect(useDesignCanvasStore.getState().shapes).toEqual([]);
    expect(useDesignCanvasStore.getState().connectors).toEqual([]);
    expect(useDesignCanvasStore.getState().canEditUndo()).toBe(false);
  });

  it('agent 自建未触碰节点的移动与改名免批', async () => {
    renderHook(() => useCanvasProposalReview());
    fireAsk({
      requestId: 'direct-edit',
      sessionId: 'S1',
      ops: [
        { kind: 'moveNode', nodeId: 'A', x: 50, y: 60 },
        { kind: 'renameNode', nodeId: 'B', label: '结算页' },
      ],
    });
    await waitFor(() => expect(useDesignCanvasStore.getState().nodes[0].x).toBe(50));
    expect(useDesignCanvasStore.getState().nodes[1].label).toBe('结算页');
    expect(useCanvasProposalStore.getState().pending).toBeNull();
  });

  it('修改 userTouched 内容保留审批，并使用专用审批原因', () => {
    load([node('A', { userTouchedAt: 10 })]);
    renderHook(() => useCanvasProposalReview());
    fireAsk({ requestId: 'gate-touch', sessionId: 'S1', ops: [{ kind: 'renameNode', nodeId: 'A', label: '覆盖' }] });
    expect(useDesignCanvasStore.getState().nodes[0].label).toBeUndefined();
    expect(useCanvasProposalStore.getState().pending?.ops).toHaveLength(1);
    expect(useCanvasProposalStore.getState().approvalReason).toBe('user-touched');
  });

  it('混合批次先落新增，删除单独审批；批准后聚合回灌原请求计数', async () => {
    const { result } = renderHook(() => useCanvasProposalReview());
    fireAsk({
      requestId: 'mixed',
      sessionId: 'S1',
      ops: [
        { kind: 'addShape', shape: { kind: 'rect', x: 0, y: 0, width: 10, height: 10 } },
        { kind: 'discardNode', nodeId: 'A' },
      ],
    });

    await waitFor(() => expect(useDesignCanvasStore.getState().shapes).toHaveLength(1));
    expect(useDesignCanvasStore.getState().nodes[0].discarded).toBeUndefined();
    expect(useCanvasProposalStore.getState().pending?.ops).toEqual([{ kind: 'discardNode', nodeId: 'A' }]);
    expect(invokeMock).not.toHaveBeenCalledWith(
      IPC_CHANNELS.CANVAS_PROPOSAL_RESPONSE,
      expect.objectContaining({ requestId: 'mixed' }),
    );

    await act(async () => { await result.current.apply(); });
    expect(useDesignCanvasStore.getState().nodes[0].discarded).toBe(true);
    expect(invokeMock).toHaveBeenCalledWith(IPC_CHANNELS.CANVAS_PROPOSAL_RESPONSE, expect.objectContaining({
      requestId: 'mixed', verdict: 'apply', appliedCount: 2, skippedCount: 0,
    }));
  });
});
