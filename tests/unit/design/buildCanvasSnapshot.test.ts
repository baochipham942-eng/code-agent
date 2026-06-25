// ADR-026 D1-B：buildCanvasSnapshot 纯函数（排除 discarded + 截断 + 连线随节点裁剪）。
import { describe, it, expect } from 'vitest';
import { buildCanvasSnapshot } from '../../../src/renderer/components/design/buildCanvasSnapshot';
import type { CanvasNode } from '../../../src/renderer/components/design/designCanvasTypes';
import { CANVAS_SNAPSHOT_MAX_NODES } from '../../../src/shared/contract/canvasProposal';

const node = (id: string, over: Partial<CanvasNode> = {}): CanvasNode => ({ id, src: `a/${id}.png`, x: 1, y: 2, width: 100, height: 200, createdAt: 1, ...over });

describe('buildCanvasSnapshot', () => {
  it('label 取 label || prompt；video kind 透传', () => {
    const snap = buildCanvasSnapshot({
      nodes: [node('a', { label: '登录页' }), node('b', { prompt: '首页草图' }), node('v', { kind: 'video', durationSec: 5 } as Partial<CanvasNode>)],
      connectors: [], shapes: [],
    });
    expect(snap.nodes.find((n) => n.id === 'a')?.label).toBe('登录页');
    expect(snap.nodes.find((n) => n.id === 'b')?.label).toBe('首页草图');
    expect(snap.nodes.find((n) => n.id === 'v')?.kind).toBe('video');
  });

  it('排除 discarded 节点', () => {
    const snap = buildCanvasSnapshot({ nodes: [node('a'), node('dead', { discarded: true })], connectors: [], shapes: [] });
    expect(snap.nodes.map((n) => n.id)).toEqual(['a']);
  });

  it('连线只保留两端都在快照里的', () => {
    const snap = buildCanvasSnapshot({
      nodes: [node('a'), node('b'), node('gone', { discarded: true })],
      connectors: [{ id: 'c1', fromNodeId: 'a', toNodeId: 'b', createdAt: 1 }, { id: 'c2', fromNodeId: 'a', toNodeId: 'gone', createdAt: 1 }],
      shapes: [],
    });
    expect(snap.connectors).toHaveLength(1);
    expect(snap.connectors[0]).toMatchObject({ fromNodeId: 'a', toNodeId: 'b' });
  });

  it('shapeCount = 形状数', () => {
    const snap = buildCanvasSnapshot({ nodes: [node('a')], connectors: [], shapes: [{ id: 's', kind: 'rect', x: 0, y: 0, width: 1, height: 1, color: '#000', createdAt: 1 }] });
    expect(snap.shapeCount).toBe(1);
  });

  it('超上限：截断 + truncated 标记', () => {
    const many = Array.from({ length: CANVAS_SNAPSHOT_MAX_NODES + 5 }, (_, i) => node(`n${i}`));
    const snap = buildCanvasSnapshot({ nodes: many, connectors: [], shapes: [] });
    expect(snap.nodes).toHaveLength(CANVAS_SNAPSHOT_MAX_NODES);
    expect(snap.truncated).toBe(true);
  });
});
