import { describe, it, expect } from 'vitest';
import type { CanvasNode } from '@renderer/components/design/designCanvasTypes';
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
} from '@renderer/components/design/canvasEditHistory';

function node(id: string, label?: string): CanvasNode {
  return { id, src: `assets/${id}.png`, x: 0, y: 0, width: 10, height: 10, createdAt: 1, ...(label ? { label } : {}) };
}

function nodeAt(id: string, over: Partial<CanvasNode> = {}): CanvasNode {
  return { id, src: `assets/${id}.png`, x: 0, y: 0, width: 10, height: 10, createdAt: 1, ...over } as CanvasNode;
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
    const before: CanvasNode[] = [node('a', 'orig')];
    const s = pushSnapshot(emptyEditHistory(), before);
    // 篡改原引用（模拟后续 updateNode 直接改 node 字段）
    (before[0] as { label?: string }).label = 'mutated';
    const res = undoEdit(s, []);
    expect(res).not.toBeNull();
    expect(res!.nodes[0].label).toBe('orig'); // 深拷贝才能守住
  });

  it('pushSnapshot 清空 future（新编辑破坏 redo 链）', () => {
    let s = pushSnapshot(emptyEditHistory(), [node('a')]);
    s = undoEdit(s, [node('b')])!.stack; // 此时 future 有一帧
    expect(canEditRedo(s)).toBe(true);
    s = pushSnapshot(s, [node('c')]);
    expect(canEditRedo(s)).toBe(false);
    expect(s.future).toEqual([]);
  });

  it('pushSnapshot 截断到 MAX_EDIT_HISTORY，丢最老的', () => {
    let s = emptyEditHistory();
    for (let i = 0; i < MAX_EDIT_HISTORY + 5; i++) s = pushSnapshot(s, [node(`n${i}`)]);
    expect(s.past.length).toBe(MAX_EDIT_HISTORY);
    // 最老的 n0..n4 应被挤掉，past[0] 是 n5
    expect(s.past[0][0].id).toBe('n5');
  });

  it('undoEdit 返回上一帧，并把 current 推进 future', () => {
    const s = pushSnapshot(emptyEditHistory(), [node('prev')]);
    const res = undoEdit(s, [node('current')]);
    expect(res!.nodes[0].id).toBe('prev');
    expect(canEditUndo(res!.stack)).toBe(false);
    expect(canEditRedo(res!.stack)).toBe(true);
  });

  it('undoEdit 空 past 返回 null', () => {
    expect(undoEdit(emptyEditHistory(), [node('x')])).toBeNull();
  });

  it('redoEdit 返回下一帧，并把 current 推回 past', () => {
    let s = pushSnapshot(emptyEditHistory(), [node('prev')]);
    s = undoEdit(s, [node('current')])!.stack;
    const res = redoEdit(s, [node('prev')]);
    expect(res!.nodes[0].id).toBe('current');
    expect(canEditUndo(res!.stack)).toBe(true);
    expect(canEditRedo(res!.stack)).toBe(false);
  });

  it('redoEdit 空 future 返回 null', () => {
    expect(redoEdit(emptyEditHistory(), [node('x')])).toBeNull();
  });

  it('undo→redo 往返还原', () => {
    const s = pushSnapshot(emptyEditHistory(), [node('v1')]);
    const u = undoEdit(s, [node('v2')])!;
    expect(u.nodes[0].id).toBe('v1');
    const r = redoEdit(u.stack, u.nodes)!;
    expect(r.nodes[0].id).toBe('v2');
  });

  it('redo 推回 past 也深拷贝——current 后续被改不污染', () => {
    let s = pushSnapshot(emptyEditHistory(), [node('prev')]);
    const current: CanvasNode[] = [node('current', 'orig')];
    s = undoEdit(s, current)!.stack;
    (current[0] as { label?: string }).label = 'mutated';
    const res = redoEdit(s, [node('prev')]);
    expect(res!.nodes[0].label).toBe('orig');
  });

  it('clearHistory 清空两栈', () => {
    let s = pushSnapshot(emptyEditHistory(), [node('a')]);
    s = clearHistory();
    expect(s.past).toEqual([]);
    expect(s.future).toEqual([]);
  });
});

describe('reconcileUndoFrame（还原帧 × 当前态调和，修 HIGH-1）', () => {
  it('存活节点：还原几何/label，但保留当前 chosen/discarded（Layer2 不被 undo 抹掉）', () => {
    // 快照时 A 在 x=0、chosen=false；之后 A 被移动到 x=999 且被 setChosen
    const frame = [nodeAt('A', { x: 0, chosen: false })];
    const current = [nodeAt('A', { x: 999, chosen: true })];
    const out = reconcileUndoFrame(frame, current);
    expect(out).toHaveLength(1);
    expect(out[0].x).toBe(0); // 几何还原
    expect(out[0].chosen).toBe(true); // 当前主版选择保留（不被还原帧抹掉）
  });

  it('快照后新增的节点（import/生成）不丢：current 有 frame 无 → 保留追加', () => {
    const frame = [nodeAt('A')];
    const current = [nodeAt('A'), nodeAt('B')]; // B 是快照后 import 进来的
    const out = reconcileUndoFrame(frame, current);
    expect(out.map((n) => n.id)).toEqual(['A', 'B']);
  });

  it('快照后被删的节点：frame 有 current 无 → 从 frame 还原（撤销删除）', () => {
    const frame = [nodeAt('A'), nodeAt('B')];
    const current = [nodeAt('A')]; // B 被删
    const out = reconcileUndoFrame(frame, current);
    expect(out.map((n) => n.id)).toEqual(['A', 'B']);
  });

  it('discarded 也按当前态保留', () => {
    const frame = [nodeAt('A', { discarded: false })];
    const current = [nodeAt('A', { discarded: true })];
    const out = reconcileUndoFrame(frame, current);
    expect(out[0].discarded).toBe(true);
  });

  it('被删节点从 frame 还原时，带回它快照时的 chosen/discarded（不在 current 无从覆盖）', () => {
    const frame = [nodeAt('A'), nodeAt('B', { chosen: true })];
    const current = [nodeAt('A')];
    const out = reconcileUndoFrame(frame, current);
    expect(out.find((n) => n.id === 'B')?.chosen).toBe(true);
  });
});
