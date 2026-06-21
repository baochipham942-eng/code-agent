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

describe('designCanvasStore setChosen / deleteNode', () => {
  beforeEach(() => {
    useDesignCanvasStore.getState().loadDoc('run-x', doc([]));
  });

  it('setChosen 标记主版，并清同版本组(同 parentId)其他主版', () => {
    const s = useDesignCanvasStore.getState();
    // A 为底图；A1/A2 是 A 的两个重绘版本(同 parentId='A')
    s.loadDoc('run-x', doc([n('A'), n('A1', 'A'), n('A2', 'A')]));
    s.setChosen('A1');
    let nodes = useDesignCanvasStore.getState().nodes;
    expect(nodes.find((x) => x.id === 'A1')?.chosen).toBe(true);
    // 选另一版 → A1 主版标记被清
    useDesignCanvasStore.getState().setChosen('A2');
    nodes = useDesignCanvasStore.getState().nodes;
    expect(nodes.find((x) => x.id === 'A2')?.chosen).toBe(true);
    expect(nodes.find((x) => x.id === 'A1')?.chosen).toBe(false);
  });

  it('不同版本组互不影响', () => {
    const s = useDesignCanvasStore.getState();
    s.loadDoc('run-x', doc([n('A1', 'A'), n('B1', 'B')]));
    s.setChosen('A1');
    s.setChosen('B1');
    const nodes = useDesignCanvasStore.getState().nodes;
    expect(nodes.find((x) => x.id === 'A1')?.chosen).toBe(true);
    expect(nodes.find((x) => x.id === 'B1')?.chosen).toBe(true);
  });

  it('setChosen 选中编辑版会清掉同槽原图主版（groupKey=parentId??id）', () => {
    const s = useDesignCanvasStore.getState();
    // A 原图先是主版，A1 是 A 的重绘版
    s.loadDoc('run-x', doc([{ ...n('A'), chosen: true }, n('A1', 'A')]));
    s.setChosen('A1');
    const nodes = useDesignCanvasStore.getState().nodes;
    expect(nodes.find((x) => x.id === 'A1')?.chosen).toBe(true);
    expect(nodes.find((x) => x.id === 'A')?.chosen).toBe(false); // 同槽原图主版被清
  });

  it('discardNode 软删除：节点保留只标 discarded，并清出选择', () => {
    const s = useDesignCanvasStore.getState();
    s.loadDoc('run-x', doc([n('A'), n('B')]));
    s.setSelected(['A', 'B']);
    s.discardNode('A');
    const st = useDesignCanvasStore.getState();
    expect(st.nodes.map((x) => x.id)).toEqual(['A', 'B']); // 没真删
    expect(st.nodes.find((x) => x.id === 'A')?.discarded).toBe(true);
    expect(st.selectedIds).toEqual(['B']);
  });

  it('discardNode 淘汰主版 → 同槽最新活跃版自动升主版', () => {
    const s = useDesignCanvasStore.getState();
    s.loadDoc(
      'run-x',
      doc([
        { ...n('A'), createdAt: 1 },
        { ...n('A1', 'A'), createdAt: 2 },
        { ...n('A2', 'A'), chosen: true, createdAt: 3 },
      ]),
    );
    s.discardNode('A2'); // 淘汰当前主版
    const nodes = useDesignCanvasStore.getState().nodes;
    expect(nodes.find((x) => x.id === 'A2')?.discarded).toBe(true);
    expect(nodes.find((x) => x.id === 'A1')?.chosen).toBe(true); // 最新活跃版 A1 升主版
  });

  it('deleteNode 移除节点并清出选择', () => {
    const s = useDesignCanvasStore.getState();
    s.loadDoc('run-x', doc([n('A'), n('B')]));
    s.setSelected(['A', 'B']);
    s.deleteNode('A');
    const st = useDesignCanvasStore.getState();
    expect(st.nodes.map((x) => x.id)).toEqual(['B']);
    expect(st.selectedIds).toEqual(['B']);
  });
});
