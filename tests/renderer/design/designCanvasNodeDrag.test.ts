// 画布节点拖动（用户侧）store 层钉板：
//  1) markNodeUserTouched 只打 userTouchedAt 戳、不进 Layer1 undo 历史（dragStart 用，空撤销帧禁令）；
//  2) 归因链：agent 自建未碰节点 moveNode 免批直落，dragStart 打戳后必须走审批（user-touched）；
//  3) 拖动落点走 updateNode：一次拖动一帧 undo，连续 N 次拖动 N 帧可逐帧回退。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useDesignCanvasStore } from '../../../src/renderer/components/design/designCanvasStore';
import { hasUserTouch } from '../../../src/renderer/components/design/canvasActor';
import { splitCanvasProposalOps } from '../../../src/renderer/components/design/canvasProposalApproval';
import type { CanvasImageNode, DesignCanvasDoc } from '../../../src/renderer/components/design/designCanvasTypes';

const NOW = new Date('2026-08-02T08:00:00.000Z');
const NOW_MS = NOW.getTime();

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

function load(nodes: CanvasImageNode[] = [node('A')]): void {
  const doc: DesignCanvasDoc = { version: 1, nodes, camera: { x: 0, y: 0, scale: 1 } };
  useDesignCanvasStore.getState().loadDoc('run-drag', doc);
}

const get = () => useDesignCanvasStore.getState();
const historyLen = () => ({
  past: get().editHistory.past.length,
  future: get().editHistory.future.length,
});

describe('markNodeUserTouched（dragStart 打戳）', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    load();
  });

  afterEach(() => vi.useRealTimers());

  it('打戳后 hasUserTouch 为真，保留 createdBy=agent，坐标不动', () => {
    get().markNodeUserTouched('A');
    const a = get().nodes.find((n) => n.id === 'A')!;
    expect(hasUserTouch(a)).toBe(true);
    expect(a.userTouchedAt).toBe(NOW_MS);
    expect(a.createdBy).toBe('agent');
    expect({ x: a.x, y: a.y }).toEqual({ x: 0, y: 0 });
  });

  it('不产生 undo 帧（past/future 长度均不变）', () => {
    const before = historyLen();
    get().markNodeUserTouched('A');
    expect(historyLen()).toEqual(before);
    expect(get().canEditUndo()).toBe(false);
  });

  it('节点不存在时 no-op（不动状态、不留撤销点）', () => {
    const nodesBefore = get().nodes;
    get().markNodeUserTouched('missing');
    expect(get().nodes).toBe(nodesBefore);
    expect(historyLen()).toEqual({ past: 0, future: 0 });
  });
});

describe('拖动归因链（splitCanvasProposalOps 分级免审批）', () => {
  beforeEach(() => load());

  it('agent 自建且未碰过的节点：moveNode 免批直落', () => {
    const split = splitCanvasProposalOps([{ kind: 'moveNode', nodeId: 'A', x: 5, y: 6 }], get().nodes);
    expect(split.directOps).toHaveLength(1);
    expect(split.approvalOps).toHaveLength(0);
  });

  it('dragStart 打戳后：同一 moveNode 必须走审批且 approvalReason=user-touched', () => {
    get().markNodeUserTouched('A');
    const split = splitCanvasProposalOps([{ kind: 'moveNode', nodeId: 'A', x: 5, y: 6 }], get().nodes);
    expect(split.directOps).toHaveLength(0);
    expect(split.approvalOps).toHaveLength(1);
    expect(split.approvalReason).toBe('user-touched');
  });
});

describe('拖动落点（updateNode）undo 语义', () => {
  beforeEach(() => load());

  it('拖一次 → 恰好一步撤回到原位', () => {
    get().updateNode('A', { x: 10, y: 20 });
    expect(historyLen().past).toBe(1);
    get().undoEdit();
    const a = get().nodes.find((n) => n.id === 'A')!;
    expect({ x: a.x, y: a.y }).toEqual({ x: 0, y: 0 });
    expect(get().canEditUndo()).toBe(false);
  });

  it('连续拖 3 次 → 3 帧可逐帧回退到起点', () => {
    get().updateNode('A', { x: 10, y: 20 });
    get().updateNode('A', { x: 30, y: 40 });
    get().updateNode('A', { x: 50, y: 60 });
    expect(historyLen().past).toBe(3);
    get().undoEdit();
    expect(get().nodes[0]).toMatchObject({ x: 30, y: 40 });
    get().undoEdit();
    expect(get().nodes[0]).toMatchObject({ x: 10, y: 20 });
    get().undoEdit();
    expect(get().nodes[0]).toMatchObject({ x: 0, y: 0 });
    expect(get().canEditUndo()).toBe(false);
  });
});
