import { describe, expect, it } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  DesignLayerPanel,
  layerDisplayName,
  layerKindLabel,
  orderedLayerNodes,
} from '../../../src/renderer/components/design/DesignLayerPanel';
import type { CanvasImageNode, CanvasVideoNode } from '../../../src/renderer/components/design/designCanvasTypes';
import { en } from '../../../src/renderer/i18n/en';

const image = (over: Partial<CanvasImageNode> = {}): CanvasImageNode => ({
  id: 'img',
  src: 'assets/img.png',
  x: 10,
  y: 20,
  width: 300,
  height: 200,
  createdAt: 1,
  ...over,
  createdBy: over.createdBy ?? 'user',
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
  createdBy: over.createdBy ?? 'user',
});

describe('DesignLayerPanel helpers', () => {
  it('orders active nodes first and then newest first', () => {
    const nodes = [
      image({ id: 'old', createdAt: 1 }),
      image({ id: 'discarded', createdAt: 99, discarded: true }),
      video({ id: 'new', createdAt: 2 }),
    ];
    expect(orderedLayerNodes(nodes).map((node) => node.id)).toEqual(['new', 'old', 'discarded']);
  });

  it('derives display names and kind labels', () => {
    expect(layerDisplayName(image({ label: 'Hero' }), '未命名节点')).toBe('Hero');
    expect(layerDisplayName(image({ prompt: '首页' }), '未命名节点')).toBe('首页');
    expect(layerDisplayName(image(), '未命名节点')).toBe('未命名节点');
    expect(layerKindLabel(video(), { image: '图片', video: '视频' })).toBe('视频');
    expect(layerKindLabel(image(), { image: '图片', video: '视频' })).toBe('图片');
  });
});

describe('DesignLayerPanel', () => {
  it('renders layer count, badges, and selected inspector', () => {
    const nodes = [
      image({ id: 'hero', label: 'Hero', chosen: true, costCny: 0.14, parentId: 'root' }),
      video({ id: 'discarded-video', discarded: true }),
    ];
    const html = renderToStaticMarkup(
      <DesignLayerPanel
        nodes={nodes}
        selectedIds={['hero']}
        onSelect={() => {}}
        onRename={() => {}}
        onSetChosen={() => {}}
        onDiscard={() => {}}
        onDelete={() => {}}
        onFocus={() => {}}
      />,
    );
    expect(html).toContain('Hero');
    expect(html).toContain('主版');
    expect(html).toContain('已淘汰');
    expect(html).toContain('图层名称');
    expect(html).toContain('成本');
    expect(html).toContain('父节点');
    expect(html).toContain('设为主版');
    expect(html).toContain('淘汰');
    expect(html).toContain('删除');
    // 返工#5：X/Y/W/H/成本/父节点 收进默认折叠的 <details>（字段不删，只是默认不展示）
    expect(html).toContain('<details data-testid="design-layer-details"');
    expect(html).not.toContain('<details open');
    expect(html).toContain('详情');
  });

  it('K1：设为主版保文字占满；淘汰/删除收图标 + title，且图标可区分（Archive vs Trash2）', () => {
    const html = renderToStaticMarkup(
      <DesignLayerPanel
        nodes={[image({ id: 'hero', label: 'Hero' })]}
        selectedIds={['hero']}
        onSelect={() => {}}
        onRename={() => {}}
        onSetChosen={() => {}}
        onDiscard={() => {}}
        onDelete={() => {}}
        onFocus={() => {}}
      />,
    );
    // 主动作保文字
    expect(html).toContain('设为主版');
    // 淘汰/删除收图标 + title 悬停提示（文字只存在于 title/aria-label，不再是按钮文本节点）
    expect(html).toContain('title="淘汰"');
    expect(html).toContain('title="删除"');
    expect(html).not.toContain('>淘汰</button>');
    expect(html).not.toContain('>删除</button>');
    // 两个图标必须可区分：淘汰=归档 Archive、删除=垃圾桶 Trash2
    expect(html).toContain('lucide-archive');
    expect(html).toContain('lucide-trash-2');
  });

  it('renders English copy through i18n', () => {
    const html = renderToStaticMarkup(
      <DesignLayerPanel
        nodes={[image({ id: 'hero', label: 'Hero', chosen: true })]}
        selectedIds={['hero']}
        onSelect={() => {}}
        onRename={() => {}}
        onSetChosen={() => {}}
        onDiscard={() => {}}
        onDelete={() => {}}
        onFocus={() => {}}
        translations={en}
      />,
    );
    expect(html).toContain('Layer name');
    expect(html).toContain('Set main');
    expect(html).toContain('Discard');
    expect(html).toContain('Delete');
  });
});
