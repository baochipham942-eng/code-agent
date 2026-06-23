import { describe, expect, it, beforeEach } from 'vitest';
import { useDesignCanvasStore } from '../../../src/renderer/components/design/designCanvasStore';
import type { DesignCanvasDoc, CanvasImageNode } from '../../../src/renderer/components/design/designCanvasTypes';

const n = (id: string, parentId?: string): CanvasImageNode => ({
  id,
  src: `assets/${id}.png`,
  x: 0,
  y: 0,
  width: 100,
  height: 100,
  parentId,
  createdAt: 1,
});

const doc = (nodes: CanvasImageNode[]): DesignCanvasDoc => ({ version: 1, nodes, camera: { x: 0, y: 0, scale: 1 } });

describe('designCanvasStore undo/redo (Layer1 编辑历史)', () => {
  beforeEach(() => {
    useDesignCanvasStore.getState().loadDoc('run-x', doc([]));
  });

  it('初始无可撤销/重做', () => {
    const s = useDesignCanvasStore.getState();
    expect(s.canEditUndo()).toBe(false);
    expect(s.canEditRedo()).toBe(false);
  });

  it('updateNode 产生撤销点，undoEdit 还原编辑前坐标', () => {
    const s = useDesignCanvasStore.getState();
    s.loadDoc('run-x', doc([n('A')]));
    s.updateNode('A', { x: 999 });
    expect(useDesignCanvasStore.getState().nodes[0].x).toBe(999);
    expect(useDesignCanvasStore.getState().canEditUndo()).toBe(true);
    useDesignCanvasStore.getState().undoEdit();
    expect(useDesignCanvasStore.getState().nodes[0].x).toBe(0);
  });

  it('deleteNode 可撤销，undoEdit 恢复被删节点', () => {
    const s = useDesignCanvasStore.getState();
    s.loadDoc('run-x', doc([n('A'), n('B')]));
    s.deleteNode('B');
    expect(useDesignCanvasStore.getState().nodes.map((x) => x.id)).toEqual(['A']);
    useDesignCanvasStore.getState().undoEdit();
    expect(useDesignCanvasStore.getState().nodes.map((x) => x.id)).toEqual(['A', 'B']);
  });

  it('renameNode 可撤销', () => {
    const s = useDesignCanvasStore.getState();
    s.loadDoc('run-x', doc([n('A')]));
    s.renameNode('A', '新名');
    expect(useDesignCanvasStore.getState().nodes[0].label).toBe('新名');
    useDesignCanvasStore.getState().undoEdit();
    expect(useDesignCanvasStore.getState().nodes[0].label).toBeUndefined();
  });

  it('undo 后 redoEdit 重做', () => {
    const s = useDesignCanvasStore.getState();
    s.loadDoc('run-x', doc([n('A')]));
    s.updateNode('A', { x: 50 });
    useDesignCanvasStore.getState().undoEdit();
    expect(useDesignCanvasStore.getState().nodes[0].x).toBe(0);
    useDesignCanvasStore.getState().redoEdit();
    expect(useDesignCanvasStore.getState().nodes[0].x).toBe(50);
  });

  it('Layer 边界：addNode（生成路径）不产生编辑撤销点', () => {
    const s = useDesignCanvasStore.getState();
    s.loadDoc('run-x', doc([n('A')]));
    s.addNode(n('B'));
    expect(useDesignCanvasStore.getState().canEditUndo()).toBe(false);
  });

  it('Layer 边界：setChosen / discardNode（spine 操作）不进编辑历史', () => {
    const s = useDesignCanvasStore.getState();
    s.loadDoc('run-x', doc([n('A1', 'A'), n('A2', 'A')]));
    s.setChosen('A1');
    s.discardNode('A2');
    expect(useDesignCanvasStore.getState().canEditUndo()).toBe(false);
  });

  it('loadDoc 清空编辑历史', () => {
    const s = useDesignCanvasStore.getState();
    s.loadDoc('run-x', doc([n('A')]));
    s.updateNode('A', { x: 1 });
    expect(useDesignCanvasStore.getState().canEditUndo()).toBe(true);
    useDesignCanvasStore.getState().loadDoc('run-y', doc([n('C')]));
    expect(useDesignCanvasStore.getState().canEditUndo()).toBe(false);
  });

  it('resetCanvas 清空编辑历史', () => {
    const s = useDesignCanvasStore.getState();
    s.loadDoc('run-x', doc([n('A')]));
    s.updateNode('A', { x: 1 });
    useDesignCanvasStore.getState().resetCanvas();
    expect(useDesignCanvasStore.getState().canEditUndo()).toBe(false);
  });

  it('新编辑清空 redo 链', () => {
    const s = useDesignCanvasStore.getState();
    s.loadDoc('run-x', doc([n('A')]));
    s.updateNode('A', { x: 10 });
    useDesignCanvasStore.getState().undoEdit();
    expect(useDesignCanvasStore.getState().canEditRedo()).toBe(true);
    useDesignCanvasStore.getState().updateNode('A', { x: 20 });
    expect(useDesignCanvasStore.getState().canEditRedo()).toBe(false);
  });

  it('clearEditHistory 清空两向', () => {
    const s = useDesignCanvasStore.getState();
    s.loadDoc('run-x', doc([n('A')]));
    s.updateNode('A', { x: 1 });
    useDesignCanvasStore.getState().clearEditHistory();
    expect(useDesignCanvasStore.getState().canEditUndo()).toBe(false);
    expect(useDesignCanvasStore.getState().canEditRedo()).toBe(false);
  });

  // —— HIGH-1：undo 不抹掉快照后的 Layer2 变更与新增节点 ——
  it('HIGH-1：move→setChosen→undo，主版选择不被抹掉', () => {
    const s = useDesignCanvasStore.getState();
    s.loadDoc('run-x', doc([n('A1', 'A'), n('A2', 'A')])); // 同槽
    s.updateNode('A1', { x: 999 }); // 编辑（进 Layer1 快照,此刻无 chosen）
    s.setChosen('A2'); // Layer2 选主版（不进 Layer1）
    useDesignCanvasStore.getState().undoEdit(); // 撤 A1 的移动
    const nodes = useDesignCanvasStore.getState().nodes;
    expect(nodes.find((x) => x.id === 'A1')?.x).toBe(0); // 移动已撤
    expect(nodes.find((x) => x.id === 'A2')?.chosen).toBe(true); // 主版选择保留(修复前会被抹成 false)
  });

  it('skeptic HIGH-1：delete→undo→redo 重新删除生效（redo 不复活被删节点）', () => {
    const s = useDesignCanvasStore.getState();
    s.loadDoc('run-x', doc([n('A'), n('B')]));
    s.deleteNode('B');
    useDesignCanvasStore.getState().undoEdit(); // B 恢复
    expect(useDesignCanvasStore.getState().nodes.map((x) => x.id).sort()).toEqual(['A', 'B']);
    useDesignCanvasStore.getState().redoEdit(); // 重做删除
    expect(useDesignCanvasStore.getState().nodes.map((x) => x.id)).toEqual(['A']);
  });

  it('skeptic HIGH-1 配套：addNode 清 redo 栈（add 后无法 redo 撞丢新增节点）', () => {
    const s = useDesignCanvasStore.getState();
    s.loadDoc('run-x', doc([n('A')]));
    s.updateNode('A', { x: 10 });
    useDesignCanvasStore.getState().undoEdit(); // 可重做
    expect(useDesignCanvasStore.getState().canEditRedo()).toBe(true);
    useDesignCanvasStore.getState().addNode(n('B')); // 新分支：清 redo
    expect(useDesignCanvasStore.getState().canEditRedo()).toBe(false);
  });

  it('HIGH-1：move→import 新节点→undo，新增节点不丢', () => {
    const s = useDesignCanvasStore.getState();
    s.loadDoc('run-x', doc([n('A')]));
    s.updateNode('A', { x: 50 }); // 编辑快照 [A]
    s.addNode(n('B')); // 模拟 import 在快照后加入（不进 Layer1）
    useDesignCanvasStore.getState().undoEdit();
    const ids = useDesignCanvasStore.getState().nodes.map((x) => x.id);
    expect(ids).toContain('B'); // 新增节点不被 undo 抹掉(修复前会消失)
    expect(useDesignCanvasStore.getState().nodes.find((x) => x.id === 'A')?.x).toBe(0);
  });
});
