import { describe, expect, it, beforeEach } from 'vitest';
import { useDesignCanvasStore } from '../../../src/renderer/components/design/designCanvasStore';
import type { DesignCanvasDoc, CanvasImageNode } from '../../../src/renderer/components/design/designCanvasTypes';
import type { CanvasConnector, CanvasShape } from '../../../src/renderer/components/design/designDiagramTypes';

const n = (id: string): CanvasImageNode => ({
  id,
  src: `assets/${id}.png`,
  x: 0,
  y: 0,
  width: 100,
  height: 100,
  createdAt: 1,
});

const doc = (nodes: CanvasImageNode[]): DesignCanvasDoc => ({ version: 1, nodes, camera: { x: 0, y: 0, scale: 1 } });
const conn = (id: string, from: string, to: string): CanvasConnector => ({ id, fromNodeId: from, toNodeId: to, createdAt: 1 });
const rect = (id: string): CanvasShape => ({ id, kind: 'rect', x: 0, y: 0, width: 10, height: 10, color: '#64748b', createdAt: 1 });

const get = () => useDesignCanvasStore.getState();

describe('designCanvasStore 图解层连线', () => {
  beforeEach(() => get().loadDoc('run-x', doc([n('A'), n('B')])));

  it('addConnector 加连线并产生撤销点', () => {
    get().addConnector(conn('c1', 'A', 'B'));
    expect(get().connectors.map((c) => c.id)).toEqual(['c1']);
    expect(get().canEditUndo()).toBe(true);
    get().undoEdit();
    expect(get().connectors).toEqual([]);
  });

  it('拒绝端点不存在的连线', () => {
    get().addConnector(conn('c1', 'A', 'GHOST'));
    expect(get().connectors).toEqual([]);
    expect(get().canEditUndo()).toBe(false);
  });

  it('拒绝自环', () => {
    get().addConnector(conn('c1', 'A', 'A'));
    expect(get().connectors).toEqual([]);
  });

  it('拒绝重复 id', () => {
    get().addConnector(conn('c1', 'A', 'B'));
    get().addConnector(conn('c1', 'B', 'A'));
    expect(get().connectors).toHaveLength(1);
  });

  it('updateConnector 改 label 可撤销', () => {
    get().addConnector(conn('c1', 'A', 'B'));
    get().updateConnector('c1', { label: '提交' });
    expect(get().connectors[0].label).toBe('提交');
    get().undoEdit();
    expect(get().connectors[0].label).toBeUndefined();
  });

  it('deleteConnector 删除并清选中', () => {
    get().addConnector(conn('c1', 'A', 'B'));
    get().setSelectedDiagram({ type: 'connector', id: 'c1' });
    get().deleteConnector('c1');
    expect(get().connectors).toEqual([]);
    expect(get().selectedDiagram).toBeNull();
  });

  it('deleteNode 级联剪掉悬空连线', () => {
    get().addConnector(conn('c1', 'A', 'B'));
    get().deleteNode('B');
    expect(get().connectors).toEqual([]); // c1 指向已删的 B → 剪掉
    // undo 删除：节点 B 和连线 c1 一起回来（同帧快照）
    get().undoEdit();
    expect(get().nodes.map((x) => x.id).sort()).toEqual(['A', 'B']);
    expect(get().connectors.map((c) => c.id)).toEqual(['c1']);
  });
});

describe('designCanvasStore 图解层形状', () => {
  beforeEach(() => get().loadDoc('run-x', doc([])));

  it('addShape 加形状并可撤销', () => {
    get().addShape(rect('s1'));
    expect(get().shapes.map((s) => s.id)).toEqual(['s1']);
    get().undoEdit();
    expect(get().shapes).toEqual([]);
  });

  it('updateShape 改几何，id/kind 不被越权改写', () => {
    get().addShape(rect('s1'));
    get().updateShape('s1', { x: 99, kind: 'ellipse' } as Partial<CanvasShape>);
    expect(get().shapes[0].x).toBe(99);
    expect(get().shapes[0].kind).toBe('rect'); // kind 受保护
  });

  it('deleteShape 删除并清选中', () => {
    get().addShape(rect('s1'));
    get().setSelectedDiagram({ type: 'shape', id: 's1' });
    get().deleteShape('s1');
    expect(get().shapes).toEqual([]);
    expect(get().selectedDiagram).toBeNull();
  });

  it('选中图解与节点选择互斥', () => {
    get().loadDoc('run-x', doc([n('A')]));
    get().addShape(rect('s1'));
    get().setSelected(['A']);
    expect(get().selectedDiagram).toBeNull();
    get().setSelectedDiagram({ type: 'shape', id: 's1' });
    expect(get().selectedIds).toEqual([]);
  });

  it('节点编辑与图解编辑共用同一撤销栈（统一 Cmd+Z）', () => {
    get().loadDoc('run-x', doc([n('A')]));
    get().updateNode('A', { x: 50 }); // Layer1 node edit
    get().addShape(rect('s1')); // Layer1 diagram edit
    get().undoEdit(); // 撤最近：删 shape
    expect(get().shapes).toEqual([]);
    expect(get().nodes[0].x).toBe(50);
    get().undoEdit(); // 再撤：还原 node x
    expect(get().nodes[0].x).toBe(0);
  });
});

describe('designCanvasStore toDoc 带图解层', () => {
  it('toDoc 仅非空时挂 connectors/shapes', () => {
    get().loadDoc('run-x', doc([n('A'), n('B')]));
    expect(get().toDoc().connectors).toBeUndefined();
    get().addConnector(conn('c1', 'A', 'B'));
    get().addShape(rect('s1'));
    const d = get().toDoc();
    expect(d.connectors?.map((c) => c.id)).toEqual(['c1']);
    expect(d.shapes?.map((s) => s.id)).toEqual(['s1']);
  });
});
