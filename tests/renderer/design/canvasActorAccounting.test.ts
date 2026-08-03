import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useDesignCanvasStore } from '../../../src/renderer/components/design/designCanvasStore';
import type { CanvasImageNode, DesignCanvasDoc } from '../../../src/renderer/components/design/designCanvasTypes';
import type { CanvasConnector, CanvasShape } from '../../../src/renderer/components/design/designDiagramTypes';

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

const connector = (id: string, over: Partial<CanvasConnector> = {}): CanvasConnector => ({
  id,
  fromNodeId: 'A',
  toNodeId: 'B',
  createdAt: 1,
  createdBy: 'agent',
  ...over,
});

const shape = (id: string, over: Partial<CanvasShape> = {}): CanvasShape => ({
  id,
  kind: 'rect',
  x: 0,
  y: 0,
  width: 10,
  height: 10,
  color: '#64748b',
  createdAt: 1,
  createdBy: 'agent',
  ...over,
} as CanvasShape);

function load(
  nodes: CanvasImageNode[] = [node('A'), node('B')],
  connectors: CanvasConnector[] = [],
  shapes: CanvasShape[] = [],
): void {
  const doc: DesignCanvasDoc = {
    version: 1,
    nodes,
    camera: { x: 0, y: 0, scale: 1 },
    ...(connectors.length ? { connectors } : {}),
    ...(shapes.length ? { shapes } : {}),
  };
  useDesignCanvasStore.getState().loadDoc('run-actor', doc);
}

const get = () => useDesignCanvasStore.getState();

describe('designCanvasStore 用户 mutation 归因', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    load();
  });

  afterEach(() => vi.useRealTimers());

  it('addNode：默认用户创建并打 userTouchedAt', () => {
    get().addNode({ id: 'C', src: 'assets/C.png', x: 0, y: 0, width: 1, height: 1, createdAt: 2 });
    expect(get().nodes.find((item) => item.id === 'C')).toMatchObject({ createdBy: 'user', userTouchedAt: NOW_MS });
  });

  it('updateNode：保留创建者并打 userTouchedAt', () => {
    get().updateNode('A', { x: 9 });
    expect(get().nodes.find((item) => item.id === 'A')).toMatchObject({ createdBy: 'agent', userTouchedAt: NOW_MS, x: 9 });
  });

  it('deleteNodes：undo 恢复的用户否决实体带 userTouchedAt', () => {
    get().deleteNodes(['A']);
    get().undoEdit();
    expect(get().nodes.find((item) => item.id === 'A')?.userTouchedAt).toBe(NOW_MS);
  });

  it('discardNode：用户淘汰目标及自动升任主版都打戳', () => {
    load([node('A', { chosen: true }), node('A2', { parentId: 'A', createdAt: 2 })]);
    get().discardNode('A');
    expect(get().nodes.find((item) => item.id === 'A')?.userTouchedAt).toBe(NOW_MS);
    expect(get().nodes.find((item) => item.id === 'A2')).toMatchObject({ chosen: true, userTouchedAt: NOW_MS });
  });

  it('restoreNode：恢复目标打戳', () => {
    load([node('A', { discarded: true })]);
    get().restoreNode('A');
    expect(get().nodes[0].userTouchedAt).toBe(NOW_MS);
  });

  it('setChosen：同槽被改写的实体逐个打戳', () => {
    load([node('A', { chosen: true }), node('A2', { parentId: 'A' })]);
    get().setChosen('A2');
    expect(get().nodes.every((item) => item.userTouchedAt === NOW_MS)).toBe(true);
  });

  it('renameNode：目标打戳', () => {
    get().renameNode('A', '首页');
    expect(get().nodes.find((item) => item.id === 'A')).toMatchObject({ label: '首页', userTouchedAt: NOW_MS });
  });

  it('addConnector：用户创建并打戳', () => {
    get().addConnector({ id: 'c1', fromNodeId: 'A', toNodeId: 'B', createdAt: 2 });
    expect(get().connectors[0]).toMatchObject({ createdBy: 'user', userTouchedAt: NOW_MS });
  });

  it('updateConnector：保留创建者并打戳', () => {
    load(undefined, [connector('c1')]);
    get().updateConnector('c1', { label: '下一步' });
    expect(get().connectors[0]).toMatchObject({ createdBy: 'agent', userTouchedAt: NOW_MS, label: '下一步' });
  });

  it('deleteConnector：undo 恢复的实体带 userTouchedAt', () => {
    load(undefined, [connector('c1')]);
    get().deleteConnector('c1');
    get().undoEdit();
    expect(get().connectors[0].userTouchedAt).toBe(NOW_MS);
  });

  it('addShape：用户创建并打戳', () => {
    get().addShape({ id: 's1', kind: 'rect', x: 0, y: 0, width: 1, height: 1, color: '#fff', createdAt: 2 });
    expect(get().shapes[0]).toMatchObject({ createdBy: 'user', userTouchedAt: NOW_MS });
  });

  it('updateShape：保留创建者并打戳', () => {
    load(undefined, [], [shape('s1')]);
    get().updateShape('s1', { x: 12 });
    expect(get().shapes[0]).toMatchObject({ createdBy: 'agent', userTouchedAt: NOW_MS, x: 12 });
  });

  it('deleteShape：undo 恢复的实体带 userTouchedAt', () => {
    load(undefined, [], [shape('s1')]);
    get().deleteShape('s1');
    get().undoEdit();
    expect(get().shapes[0].userTouchedAt).toBe(NOW_MS);
  });

  it('undo/redo：用户主动切换版本时，恢复态与重做态都重新打戳', () => {
    get().updateNode('A', { x: 10 });
    vi.setSystemTime(NOW_MS + 1);
    get().undoEdit();
    expect(get().nodes.find((item) => item.id === 'A')).toMatchObject({ x: 0, userTouchedAt: NOW_MS + 1 });
    vi.setSystemTime(NOW_MS + 2);
    get().redoEdit();
    expect(get().nodes.find((item) => item.id === 'A')).toMatchObject({ x: 10, userTouchedAt: NOW_MS + 2 });
  });
});
describe('designCanvasStore agent mutation 归因', () => {
  beforeEach(() => load());

  it('applyProposalBatch 保持 agent 新实体未 touched，移动/改名也不伪造 user touch', () => {
    get().applyProposalBatch([
      { kind: 'moveNode', nodeId: 'A', x: 10, y: 20 },
      { kind: 'renameNode', nodeId: 'B', label: '结算' },
      { kind: 'addConnector', fromNodeId: 'A', toNodeId: 'B' },
      { kind: 'addShape', shape: { kind: 'text', x: 1, y: 2, text: '说明' } },
    ], { genId: (kind, index) => `${kind}-${index}`, now: 1000 });

    expect(get().nodes.every((item) => item.createdBy === 'agent' && item.userTouchedAt === undefined)).toBe(true);
    expect(get().connectors[0]).toMatchObject({ createdBy: 'agent' });
    expect(get().connectors[0].userTouchedAt).toBeUndefined();
    expect(get().shapes[0]).toMatchObject({ createdBy: 'agent' });
    expect(get().shapes[0].userTouchedAt).toBeUndefined();
  });

  it('共用 addNode/discardNode 显式 agent 不打 user touch', () => {
    get().addNode({ id: 'C', src: 'assets/C.png', x: 0, y: 0, width: 1, height: 1, createdAt: 2 }, 'agent');
    get().discardNode('C', 'agent');
    expect(get().nodes.find((item) => item.id === 'C')).toMatchObject({ createdBy: 'agent', discarded: true });
    expect(get().nodes.find((item) => item.id === 'C')?.userTouchedAt).toBeUndefined();
  });
});
