import { describe, expect, it } from 'vitest';
import { placeCanvasNode, placeVariantNode } from '../../../src/renderer/components/design/canvasPlacement';
import type { CanvasImageNode, CanvasVideoNode } from '../../../src/renderer/components/design/designCanvasTypes';
import { DESIGN_WORKSPACE } from '../../../src/shared/constants';

const image = (over: Partial<CanvasImageNode> = {}): CanvasImageNode => ({
  id: 'img',
  src: 'assets/img.png',
  x: 0,
  y: 0,
  width: 100,
  height: 80,
  createdAt: 1,
  ...over,
});

const video = (over: Partial<CanvasVideoNode> = {}): CanvasVideoNode => ({
  id: 'vid',
  kind: 'video',
  src: 'assets/vid.mp4',
  x: 0,
  y: 0,
  width: 160,
  height: 90,
  durationSec: 5,
  createdAt: 1,
  ...over,
});

describe('canvasPlacement root/reference placement', () => {
  it('empty canvas roots at current viewport origin', () => {
    expect(
      placeCanvasNode({
        nodes: [],
        size: { width: 100, height: 80 },
        camera: { x: -240, y: -120, scale: 2 },
        operation: 'root',
      }),
    ).toEqual({ x: 120, y: 60 });
  });

  it('reference images land left of product work and stack vertically', () => {
    const output = image({ id: 'out', x: 300, y: 40, width: 200, height: 120 });
    const ref = image({ id: 'ref', role: 'reference', x: 40, y: 0, width: 100, height: 80 });
    const first = placeCanvasNode({
      nodes: [output],
      size: { width: 100, height: 80 },
      operation: 'reference',
    });
    const second = placeCanvasNode({
      nodes: [output, ref],
      size: { width: 100, height: 80 },
      operation: 'reference',
    });
    expect(first.x).toBe(300 - 100 - DESIGN_WORKSPACE.CANVAS_NODE_GAP);
    expect(second.y).toBe(ref.y + ref.height + DESIGN_WORKSPACE.CANVAS_NODE_GAP);
  });
});

describe('canvasPlacement variants', () => {
  it('variant lands to the right of the farthest sibling in the same group', () => {
    const base = image({ id: 'base', x: 0, y: 10, width: 100, height: 80 });
    const sibling = image({ id: 'v1', parentId: 'base', x: 160, y: 10, width: 120, height: 80 });
    const next = placeVariantNode(base, [base, sibling], { width: 100, height: 80 });
    expect(next).toEqual({ x: sibling.x + sibling.width + DESIGN_WORKSPACE.CANVAS_NODE_GAP, y: base.y });
  });

  it('candidate moves down when another node occupies the target rect', () => {
    const base = image({ id: 'base', x: 0, y: 0, width: 100, height: 80 });
    const blocker = video({ id: 'blocker', x: 160, y: 0, width: 80, height: 80 });
    const next = placeCanvasNode({
      nodes: [base, blocker],
      baseNode: base,
      size: { width: 80, height: 80 },
      gap: 60,
      operation: 'variant',
    });
    expect(next).toEqual({ x: 160, y: 140 });
  });
});
