import { describe, expect, it } from 'vitest';
import {
  buildDesignSelectionContext,
  firstSelectedImageNode,
  selectionPromptHint,
} from '../../../src/renderer/components/design/designSelectionContext';
import type { CanvasImageNode, CanvasVideoNode } from '../../../src/renderer/components/design/designCanvasTypes';

const image = (over: Partial<CanvasImageNode> = {}): CanvasImageNode => ({
  id: 'img',
  src: 'assets/img.png',
  x: 10,
  y: 20,
  width: 300,
  height: 200,
  createdAt: 1,
  ...over,
});

const video = (over: Partial<CanvasVideoNode> = {}): CanvasVideoNode => ({
  id: 'vid',
  kind: 'video',
  src: 'assets/vid.mp4',
  x: 40,
  y: 50,
  width: 320,
  height: 180,
  durationSec: 5,
  createdAt: 2,
  ...over,
});

describe('designSelectionContext', () => {
  it('preserves selected order, skips discarded nodes, and records role/group data', () => {
    const nodes = [
      image({ id: 'hero', label: 'Hero', parentId: 'root', chosen: true }),
      video({ id: 'motion' }),
      image({ id: 'gone', discarded: true }),
      image({ id: 'ref', role: 'reference' }),
    ];
    const context = buildDesignSelectionContext(nodes, ['motion', 'gone', 'hero', 'missing']);
    expect(context?.selectedIds).toEqual(['motion', 'hero']);
    expect(context?.primary?.id).toBe('motion');
    expect(context?.multi).toBe(true);
    expect(context?.nodes[1]).toMatchObject({
      id: 'hero',
      type: 'image',
      label: 'Hero',
      parentId: 'root',
      groupId: 'root',
      chosen: true,
      role: 'output',
    });
  });

  it('builds a prompt hint and finds the first selected image', () => {
    const nodes = [video({ id: 'motion' }), image({ id: 'hero', prompt: '首页' })];
    const context = buildDesignSelectionContext(nodes, ['motion', 'hero']);
    const hint = selectionPromptHint(context);
    expect(hint).toContain('当前画布选中 2 个对象');
    expect(hint).toContain('motion');
    expect(hint).toContain('bounds=10,20,300x200');
    expect(firstSelectedImageNode(nodes, context)?.id).toBe('hero');
  });

  it('returns null for empty or invalid selection', () => {
    expect(buildDesignSelectionContext([image()], [])).toBeNull();
    expect(buildDesignSelectionContext([image()], ['missing'])).toBeNull();
    expect(selectionPromptHint(null)).toBeUndefined();
  });
});
