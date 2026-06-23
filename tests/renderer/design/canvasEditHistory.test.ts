import { describe, it, expect } from 'vitest';
import type { CanvasNode } from '@renderer/components/design/designCanvasTypes';
import type { CanvasConnector, CanvasShape } from '@renderer/components/design/designDiagramTypes';
import {
  MAX_EDIT_HISTORY,
  emptyEditHistory,
  pushSnapshot,
  undoEdit,
  redoEdit,
  clearHistory,
  canEditUndo,
  canEditRedo,
  reconcileUndoFrame,
  type CanvasEditSnapshot,
} from '@renderer/components/design/canvasEditHistory';

function node(id: string, label?: string): CanvasNode {
  return { id, src: `assets/${id}.png`, x: 0, y: 0, width: 10, height: 10, createdAt: 1, ...(label ? { label } : {}) };
}

function nodeAt(id: string, over: Partial<CanvasNode> = {}): CanvasNode {
  return { id, src: `assets/${id}.png`, x: 0, y: 0, width: 10, height: 10, createdAt: 1, ...over } as CanvasNode;
}

/** 快照构造助手：默认空图解层。 */
function snap(
  nodes: CanvasNode[],
  connectors: CanvasConnector[] = [],
  shapes: CanvasShape[] = [],
): CanvasEditSnapshot {
  return { nodes, connectors, shapes };
}

describe('canvasEditHistory', () => {
  it('emptyEditHistory 起始空栈，两向都不可操作', () => {
    const s = emptyEditHistory();
    expect(s.past).toEqual([]);
    expect(s.future).toEqual([]);
    expect(canEditUndo(s)).toBe(false);
    expect(canEditRedo(s)).toBe(false);
  });

  it('pushSnapshot 深拷贝快照——push 后改原数组不污染历史帧', () => {
    const before = snap([node('a', 'orig')]);
    const s = pushSnapshot(emptyEditHistory(), before);
    // 篡改原引用（模拟后续 updateNode 直接改 node 字段）
    (before.nodes[0] as { label?: string }).label = 'mutated';
    const res = undoEdit(s, snap([]));
    expect(res).not.toBeNull();
    expect(res!.snapshot.nodes[0].label).toBe('orig'); // 深拷贝才能守住
  });

  it('pushSnapshot 清空 future（新编辑破坏 redo 链）', () => {
    let s = pushSnapshot(emptyEditHistory(), snap([node('a')]));
    s = undoEdit(s, snap([node('b')]))!.stack; // 此时 future 有一帧
    expect(canEditRedo(s)).toBe(true);
    s = pushSnapshot(s, snap([node('c')]));
    expect(canEditRedo(s)).toBe(false);
    expect(s.future).toEqual([]);
  });

  it('pushSnapshot 截断到 MAX_EDIT_HISTORY，丢最老的', () => {
    let s = emptyEditHistory();
    for (let i = 0; i < MAX_EDIT_HISTORY + 5; i++) s = pushSnapshot(s, snap([node(`n${i}`)]));
    expect(s.past.length).toBe(MAX_EDIT_HISTORY);
    // 最老的 n0..n4 应被挤掉，past[0] 是 n5
    expect(s.past[0].nodes[0].id).toBe('n5');
  });

  it('undoEdit 返回上一帧，并把 current 推进 future', () => {
    const s = pushSnapshot(emptyEditHistory(), snap([node('prev')]));
    const res = undoEdit(s, snap([node('current')]));
    expect(res!.snapshot.nodes[0].id).toBe('prev');
    expect(canEditUndo(res!.stack)).toBe(false);
    expect(canEditRedo(res!.stack)).toBe(true);
  });

  it('undoEdit 空 past 返回 null', () => {
    expect(undoEdit(emptyEditHistory(), snap([node('x')]))).toBeNull();
  });

  it('redoEdit 返回下一帧，并把 current 推回 past', () => {
    let s = pushSnapshot(emptyEditHistory(), snap([node('prev')]));
    s = undoEdit(s, snap([node('current')]))!.stack;
    const res = redoEdit(s, snap([node('prev')]));
    expect(res!.snapshot.nodes[0].id).toBe('current');
    expect(canEditUndo(res!.stack)).toBe(true);
    expect(canEditRedo(res!.stack)).toBe(false);
  });

  it('redoEdit 空 future 返回 null', () => {
    expect(redoEdit(emptyEditHistory(), snap([node('x')]))).toBeNull();
  });

  it('undo→redo 往返还原', () => {
    const s = pushSnapshot(emptyEditHistory(), snap([node('v1')]));
    const u = undoEdit(s, snap([node('v2')]))!;
    expect(u.snapshot.nodes[0].id).toBe('v1');
    const r = redoEdit(u.stack, u.snapshot)!;
    expect(r.snapshot.nodes[0].id).toBe('v2');
  });

  it('redo 推回 past 也深拷贝——current 后续被改不污染', () => {
    let s = pushSnapshot(emptyEditHistory(), snap([node('prev')]));
    const current = snap([node('current', 'orig')]);
    s = undoEdit(s, current)!.stack;
    (current.nodes[0] as { label?: string }).label = 'mutated';
    const res = redoEdit(s, snap([node('prev')]));
    expect(res!.snapshot.nodes[0].label).toBe('orig');
  });

  it('clearHistory 清空两栈', () => {
    let s = pushSnapshot(emptyEditHistory(), snap([node('a')]));
    s = clearHistory();
    expect(s.past).toEqual([]);
    expect(s.future).toEqual([]);
  });
});

describe('图解层 connectors/shapes 进同一撤销栈', () => {
  const conn = (id: string): CanvasConnector => ({ id, fromNodeId: 'a', toNodeId: 'b', createdAt: 1 });
  const rect = (id: string): CanvasShape => ({ id, kind: 'rect', x: 0, y: 0, width: 10, height: 10, color: '#64748b', createdAt: 1 });

  it('快照深拷贝守住 connectors/shapes', () => {
    const before = snap([], [conn('c1')], [rect('s1')]);
    const s = pushSnapshot(emptyEditHistory(), before);
    before.connectors[0].label = 'mutated';
    const res = undoEdit(s, snap([]));
    expect(res!.snapshot.connectors[0].label).toBeUndefined();
  });

  it('undo 整帧还原 connectors/shapes（无 Layer2）', () => {
    // 画一条连线前压帧（connectors=[]），undo 应回到无连线态
    const s = pushSnapshot(emptyEditHistory(), snap([node('a'), node('b')], [], []));
    const res = undoEdit(s, snap([node('a'), node('b')], [conn('c1')], [rect('s1')]));
    expect(res!.snapshot.connectors).toEqual([]);
    expect(res!.snapshot.shapes).toEqual([]);
  });
});

describe('reconcileUndoFrame（还原帧 × 当前态调和，修 HIGH-1）', () => {
  it('存活节点：还原几何/label，但保留当前 chosen/discarded（Layer2 不被 undo 抹掉）', () => {
    const frame = snap([nodeAt('A', { x: 0, chosen: false })]);
    const current = snap([nodeAt('A', { x: 999, chosen: true })]);
    const out = reconcileUndoFrame(frame, current);
    expect(out.nodes).toHaveLength(1);
    expect(out.nodes[0].x).toBe(0); // 几何还原
    expect(out.nodes[0].chosen).toBe(true); // 当前主版选择保留（不被还原帧抹掉）
  });

  it('快照后新增的节点（import/生成）不丢：current 有 frame 无 → 保留追加', () => {
    const frame = snap([nodeAt('A')]);
    const current = snap([nodeAt('A'), nodeAt('B')]);
    const out = reconcileUndoFrame(frame, current);
    expect(out.nodes.map((n) => n.id)).toEqual(['A', 'B']);
  });

  it('快照后被删的节点：frame 有 current 无 → 从 frame 还原（撤销删除）', () => {
    const frame = snap([nodeAt('A'), nodeAt('B')]);
    const current = snap([nodeAt('A')]);
    const out = reconcileUndoFrame(frame, current);
    expect(out.nodes.map((n) => n.id)).toEqual(['A', 'B']);
  });

  it('discarded 也按当前态保留', () => {
    const frame = snap([nodeAt('A', { discarded: false })]);
    const current = snap([nodeAt('A', { discarded: true })]);
    const out = reconcileUndoFrame(frame, current);
    expect(out.nodes[0].discarded).toBe(true);
  });

  it('被删节点从 frame 还原时，带回它快照时的 chosen/discarded（不在 current 无从覆盖）', () => {
    const frame = snap([nodeAt('A'), nodeAt('B', { chosen: true })]);
    const current = snap([nodeAt('A')]);
    const out = reconcileUndoFrame(frame, current);
    expect(out.nodes.find((n) => n.id === 'B')?.chosen).toBe(true);
  });

  it('connectors/shapes 整帧还原（取 frame，不取 current）', () => {
    const frame = snap([nodeAt('A')], [{ id: 'c1', fromNodeId: 'A', toNodeId: 'Z', createdAt: 1 }], []);
    const current = snap([nodeAt('A')], [], [{ id: 's9', kind: 'text', x: 0, y: 0, text: 'x', color: '#64748b', createdAt: 1 }]);
    const out = reconcileUndoFrame(frame, current);
    expect(out.connectors.map((c) => c.id)).toEqual(['c1']);
    expect(out.shapes).toEqual([]);
  });
});
