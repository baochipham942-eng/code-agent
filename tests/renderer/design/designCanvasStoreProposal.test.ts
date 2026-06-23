// ADR-026 D3-B：applyProposalBatch 整批=一个原子撤销单元 + 全跳过不进快照。
import { describe, expect, it, beforeEach } from 'vitest';
import { useDesignCanvasStore } from '../../../src/renderer/components/design/designCanvasStore';
import type { DesignCanvasDoc, CanvasImageNode } from '../../../src/renderer/components/design/designCanvasTypes';
import type { CanvasProposalOp } from '../../../src/shared/contract/canvasProposal';

const n = (id: string): CanvasImageNode => ({ id, src: `assets/${id}.png`, x: 0, y: 0, width: 100, height: 100, createdAt: 1 });
const doc = (nodes: CanvasImageNode[]): DesignCanvasDoc => ({ version: 1, nodes, camera: { x: 0, y: 0, scale: 1 } });
const get = () => useDesignCanvasStore.getState();
let seq = 0;
const OPTS = { genId: (kind: string) => `${kind}-${seq++}`, now: 1000 };

describe('applyProposalBatch', () => {
  beforeEach(() => { seq = 0; get().loadDoc('run-x', doc([n('A'), n('B'), n('C')])); });

  it('多 op 批次：整批一次 undo 全撤（单次快照）', () => {
    const ops: CanvasProposalOp[] = [
      { kind: 'moveNode', nodeId: 'A', x: 50, y: 60 },
      { kind: 'addConnector', fromNodeId: 'A', toNodeId: 'B', label: '下一步' },
      { kind: 'renameNode', nodeId: 'C', label: '结算页' },
    ];
    const r = get().applyProposalBatch(ops, OPTS);
    expect(r.applied).toHaveLength(3);
    expect(get().nodes.find((x) => x.id === 'A')).toMatchObject({ x: 50, y: 60 });
    expect(get().connectors).toHaveLength(1);
    expect(get().nodes.find((x) => x.id === 'C')?.label).toBe('结算页');

    // 一次 undo 撤掉整批
    expect(get().canEditUndo()).toBe(true);
    get().undoEdit();
    expect(get().nodes.find((x) => x.id === 'A')).toMatchObject({ x: 0, y: 0 });
    expect(get().connectors).toHaveLength(0);
    expect(get().nodes.find((x) => x.id === 'C')?.label).toBeUndefined();
    expect(get().canEditUndo()).toBe(false); // 整批=一帧
  });

  it('全跳过（stale-target）：不改状态、不进快照', () => {
    const r = get().applyProposalBatch([{ kind: 'moveNode', nodeId: 'GHOST', x: 9, y: 9 }], OPTS);
    expect(r.changed).toBe(false);
    expect(r.skipped[0].reason).toBe('node-not-found');
    expect(get().canEditUndo()).toBe(false);
  });

  it('部分跳过：仅应用合法 op，仍是单次快照', () => {
    const ops: CanvasProposalOp[] = [
      { kind: 'moveNode', nodeId: 'A', x: 5, y: 5 },
      { kind: 'addConnector', fromNodeId: 'A', toNodeId: 'GHOST' }, // 跳过
    ];
    const r = get().applyProposalBatch(ops, OPTS);
    expect(r.applied).toHaveLength(1);
    expect(r.skipped).toHaveLength(1);
    get().undoEdit();
    expect(get().nodes.find((x) => x.id === 'A')).toMatchObject({ x: 0, y: 0 });
    expect(get().canEditUndo()).toBe(false);
  });

  it('redo 能重做整批（reconcileRedoFrame 路径不串味）', () => {
    get().applyProposalBatch([{ kind: 'addConnector', fromNodeId: 'A', toNodeId: 'B' }], OPTS);
    get().undoEdit();
    expect(get().connectors).toHaveLength(0);
    get().redoEdit();
    expect(get().connectors).toHaveLength(1);
  });
});
