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
});
