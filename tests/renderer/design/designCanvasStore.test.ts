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

  it('discardNode 淘汰主版会清掉自身 chosen（防恢复后双主版）', () => {
    const s = useDesignCanvasStore.getState();
    s.loadDoc(
      'run-x',
      doc([
        { ...n('A'), createdAt: 1 },
        { ...n('A1', 'A'), chosen: true, createdAt: 2 },
      ]),
    );
    s.discardNode('A1');
    const nodes = useDesignCanvasStore.getState().nodes;
    expect(nodes.find((x) => x.id === 'A1')?.chosen).toBe(false); // 自身 chosen 被清
    expect(nodes.find((x) => x.id === 'A')?.chosen).toBe(true); // A 升主版
  });

  it('深层血缘根锚定：编辑「编辑版」也归同槽（A/A1/A2 同 parentId=A）→ 单主版', () => {
    const s = useDesignCanvasStore.getState();
    // editRegion 现以 groupKey(base) 作 parentId：A1、A2 都锚定到根 A
    s.loadDoc('run-x', doc([n('A'), n('A1', 'A'), n('A2', 'A')]));
    s.setChosen('A2');
    const nodes = useDesignCanvasStore.getState().nodes;
    const chosen = nodes.filter((x) => x.chosen);
    expect(chosen.map((x) => x.id)).toEqual(['A2']); // 全槽仅一个主版
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

  it('deleteNodes 批量移除节点并清出选择', () => {
    const s = useDesignCanvasStore.getState();
    s.loadDoc('run-x', doc([n('A'), n('B'), n('C')]));
    s.setSelected(['A', 'B']);
    s.deleteNodes(['A', 'B']);
    const st = useDesignCanvasStore.getState();
    expect(st.nodes.map((x) => x.id)).toEqual(['C']);
    expect(st.selectedIds).toEqual([]);
  });
});

describe('designCanvasStore renameNode（T2 命名步）', () => {
  beforeEach(() => {
    useDesignCanvasStore.getState().loadDoc('run-x', doc([]));
  });

  it('renameNode 写入 label，不动其他字段', () => {
    const s = useDesignCanvasStore.getState();
    s.loadDoc('run-x', doc([n('A')]));
    s.renameNode('A', '首页英雄区 v1');
    const node = useDesignCanvasStore.getState().nodes.find((x) => x.id === 'A');
    expect(node?.label).toBe('首页英雄区 v1');
    expect(node?.src).toBe('assets/A.png');
  });

  it('renameNode 对不存在的 id 静默无操作', () => {
    const s = useDesignCanvasStore.getState();
    s.loadDoc('run-x', doc([n('A')]));
    s.renameNode('ZZ', 'x');
    expect(useDesignCanvasStore.getState().nodes).toHaveLength(1);
  });
});

describe('designCanvasStore setCamera', () => {
  beforeEach(() => {
    useDesignCanvasStore.getState().loadDoc('run-x', doc([]));
  });

  it('accepts functional updates against the latest camera', () => {
    const s = useDesignCanvasStore.getState();
    s.setCamera({ x: 10, y: 20, scale: 1 });
    useDesignCanvasStore.getState().setCamera((camera) => ({
      ...camera,
      x: camera.x + 5,
      scale: camera.scale * 2,
    }));
    expect(useDesignCanvasStore.getState().camera).toEqual({ x: 15, y: 20, scale: 2 });
  });
});

describe('discardNode 升主版 tie-break（审计 R2 LOW symmetric）', () => {
  beforeEach(() => {
    useDesignCanvasStore.getState().loadDoc('run-x', doc([]));
  });

  it('同 createdAt 兄弟升主版按 id 确定（与 slotTimeline tie-break 对齐）', () => {
    const s = useDesignCanvasStore.getState();
    // A 根；A1/A2 同 parentId=A 且同 createdAt → 淘汰主版 A 后确定升任
    s.loadDoc('run-x', doc([
      { ...n('A'), chosen: true, createdAt: 1 },
      { ...n('A1', 'A'), createdAt: 5 },
      { ...n('A2', 'A'), createdAt: 5 },
    ]));
    s.discardNode('A');
    const chosen = useDesignCanvasStore.getState().nodes.filter((x) => x.chosen).map((x) => x.id);
    // 降序 createdAt 后 id 降序 tie-break → A2 在前，确定升任 A2
    expect(chosen).toEqual(['A2']);
  });
});
